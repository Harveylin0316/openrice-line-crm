const crypto = require('crypto');
const { applyInviteFollowReward } = require('../core/inviteReward');
const { buildInviteRewardPushMessages } = require('../core/inviteRewardPushMessages');
const { buildLineMessages } = require('../core/broadcastTemplates');
const { withMessageTracking } = require('../core/messageTapTracking');
const { fetchOaProfile } = require('../core/oaFollower');
const { normalizeTwMobile, maskTwMobile } = require('../core/twPhone');

function safeEqualBase64(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createLineWebhookHandler({
  pool,
  channelSecret,
  inviteBonusMax,
  inviteFriendsPerDraw,
  linePushImageBaseCandidates = [],
  liffLotteryPushUrl = '',
  linePush,
  flowEngine = null,
  goldPigBookings = null,
  mgmEngine = null
}) {
  const friendsPerDraw = Math.max(1, Number.isFinite(Number(inviteFriendsPerDraw)) ? Number(inviteFriendsPerDraw) : 2);
  async function appendWebhookEventLog(payload) {
    await pool.query(
      `INSERT INTO line_webhook_events
        (event_type, line_user_id, invite_id, inviter_user_id, result, detail, event_timestamp, raw_event)
       VALUES
        ($1, $2, $3, $4, $5, $6,
         CASE WHEN $7::double precision > 0 THEN TO_TIMESTAMP($7::double precision / 1000.0) ELSE NULL END,
         $8::jsonb)`,
      [
        payload.eventType,
        payload.lineUserId || null,
        payload.inviteId || null,
        payload.inviterUserId || null,
        payload.result,
        payload.detail || null,
        Number(payload.eventTimestamp || 0),
        payload.rawEvent ? JSON.stringify(payload.rawEvent) : JSON.stringify({})
      ]
    );
  }

  /**
   * 由「訊息事件」收人進 users 會員表（follow 事件之外的第二個入口）。
   * xmax = 0 可判斷這次是 INSERT（新收）還是 ON CONFLICT 的 UPDATE（既有），
   * 只有新收或還沒暱稱時才去打 LINE profile API，避免每則訊息都多打一次。
   */
  async function captureUserFromMessage(lineUserId) {
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, line_user_id, blocked_at, created_at)
       VALUES ($1, '', $2, NULL, now())
       ON CONFLICT (line_user_id) DO UPDATE SET blocked_at = NULL
       RETURNING (xmax = 0) AS inserted, line_display_name`,
      ['line_' + lineUserId, lineUserId]
    );
    const row = ins.rows[0];
    if (!row) return;
    if (row.inserted || !row.line_display_name) {
      const prof = await fetchOaProfile(lineUserId);
      if (prof && (prof.displayName || prof.pictureUrl)) {
        await pool.query(
          `UPDATE users SET line_display_name = COALESCE($2, line_display_name),
             line_picture_url = COALESCE($3, line_picture_url)
           WHERE line_user_id = $1`,
          [lineUserId, prof.displayName, prof.pictureUrl]
        );
      }
    }
  }

  /**
   * 九月訂位抽獎的資格登記：使用者在 OA 輸入「訂位時用的手機號碼」。
   * 為什麼要這樣做：訂位系統只有姓名/電話，CRM 對不回 LINE（RFM 51,883 筆只有 12 筆有 lineId），
   * 所以只能讓使用者自己來綁，10 月再用電話跟出席名單比對。
   * 只在活動期間收；期間改變就改這兩個常數（一行 + 部署，一次性活動不值得做設定 UI）。
   */
  const BOOKING_CAMPAIGN_KEY = 'sep-booking';
  const BOOKING_REG_START = new Date('2026-09-01T00:00:00+08:00');
  const BOOKING_REG_END   = new Date('2026-10-05T23:59:59+08:00'); // 給用餐後幾天的補登期

  async function replyBookingText(replyToken, lineUserId, msg) {
    try {
      if (replyToken && linePush && typeof linePush.replyLineMessages === 'function') {
        return await linePush.replyLineMessages(replyToken, [msg], { lineUserId, pushType: 'booking_reg' });
      }
    } catch (e) { console.error('booking reg reply failed:', e.message); }
    return false;
  }

  async function captureBookingPhone(lineUserId, text, replyToken) {
    const phone = normalizeTwMobile(text);
    if (!phone) return false;
    const now = new Date();
    // 期間外也要回話：會傳一支光禿禿的手機號碼過來，就是在照活動指示做事，
    // 沉默會被當成壞掉。但只在活動前後的合理窗口內回，太久以前/以後就不理。
    if (now < BOOKING_REG_START) {
      await replyBookingText(replyToken, lineUserId,
        '登記還沒開始\n\n9月1日活動開跑後，把訂位用的手機號碼再傳一次，就完成登記。');
      return 'pre_period';
    }
    if (now > BOOKING_REG_END) {
      const graceEnd = new Date(BOOKING_REG_END.getTime() + 14 * 86400000);
      if (now <= graceEnd) {
        await replyBookingText(replyToken, lineUserId,
          '這次的登記已經截止了\n\n得獎名單十月公布，會用這個官方帳號通知。');
        return 'post_period';
      }
      return false;
    }
    let saved = false;
    try {
      const r = await pool.query(
        `INSERT INTO campaign_phone_registrations (campaign_key, line_user_id, phone_normalized, phone_raw)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (campaign_key, line_user_id, phone_normalized) DO NOTHING
         RETURNING id`,
        [BOOKING_CAMPAIGN_KEY, lineUserId, phone, String(text || '').slice(0, 60)]
      );
      saved = r.rowCount > 0;
    } catch (e) {
      console.error('booking phone register failed:', e.message);
      return false;
    }
    const masked = maskTwMobile(phone);
    const msg = saved
      ? '登記成功\n\n手機：' + masked + '\n\n九月在合作餐廳訂位並完成用餐，就有抽獎資格。得獎名單十月公布，會用這個官方帳號通知你。'
      : '這支手機已經登記過了\n\n手機：' + masked + '\n\n不用重複登記，得獎名單十月公布。';
    await replyBookingText(replyToken, lineUserId, msg);
    return saved ? 'registered' : 'duplicate';
  }

  /**
   * 圖文選單「登記抽獎」按鍵的入口：按鍵送出這四個字，這裡依活動期間回覆對應說明。
   * 寫死在程式而不是關鍵字規則表：期間判斷要跟 captureBookingPhone 用同一組常數，
   * 拆兩處（程式管收件、規則表管說明）遲早不同步。
   */
  async function handleBookingRegKeyword(lineUserId, text, replyToken) {
    const t = String(text || '').trim();
    if (t !== '登記抽獎' && t !== '訂位抽獎登記') return false;
    const now = new Date();
    let msg;
    if (now < BOOKING_REG_START) {
      msg = '訂位抽獎 9月1日開跑\n\n九月在合作餐廳訂位並完成用餐，就有抽獎資格。\n\n活動開始後，把訂位用的手機號碼直接傳到這裡，就完成登記。';
    } else if (now > BOOKING_REG_END) {
      const graceEnd = new Date(BOOKING_REG_END.getTime() + 14 * 86400000);
      if (now > graceEnd) return false; // 活動早就結束，交還給關鍵字/兜底回覆
      let mine = [];
      try {
        const r = await pool.query(
          `SELECT phone_normalized FROM campaign_phone_registrations
            WHERE campaign_key = $1 AND line_user_id = $2
            ORDER BY registered_at ASC LIMIT 5`,
          [BOOKING_CAMPAIGN_KEY, lineUserId]
        );
        mine = r.rows.map(x => maskTwMobile(x.phone_normalized));
      } catch (e) { console.error('booking reg lookup failed:', e.message); }
      msg = mine.length
        ? '登記已經截止了\n\n你有登記：' + mine.join('、') + '\n\n得獎名單十月公布，會用這個官方帳號通知你。'
        : '這次的登記已經截止了\n\n得獎名單十月公布，會用這個官方帳號通知。';
    } else {
      let mine = [];
      try {
        const r = await pool.query(
          `SELECT phone_normalized FROM campaign_phone_registrations
            WHERE campaign_key = $1 AND line_user_id = $2
            ORDER BY registered_at ASC LIMIT 5`,
          [BOOKING_CAMPAIGN_KEY, lineUserId]
        );
        mine = r.rows.map(x => maskTwMobile(x.phone_normalized));
      } catch (e) { console.error('booking reg lookup failed:', e.message); }
      msg = mine.length
        ? '你已經登記了：' + mine.join('、') + '\n\n用別支手機訂位的話，把那支號碼也傳過來就會一起算。得獎名單十月公布。'
        : '直接把你訂位時用的手機號碼傳到這裡，就完成登記。\n\n例如：0912345678\n\n九月在合作餐廳訂位並完成用餐，就有抽獎資格，得獎名單十月公布。';
    }
    await replyBookingText(replyToken, lineUserId, msg);
    return true;
  }

  /**
   * 訂位來源調查：解析「透過 X 訂位」「透過 X 預訂」句型並記錄。
   * 用句型比對而非寫死選項，日後圖文選單新增來源（例如「透過 Uber Eats 訂位」）不必改程式。
   * 提問句「您是透過哪裡預訂的？」不是以「透過」開頭，不會被誤判為答案。
   */
  const BOOKING_SOURCE_RE = /^透過\s*(.+?)\s*(?:訂位|預訂)\s*$/;
  async function captureBookingSource(lineUserId, text, eventTimestamp) {
    const m = BOOKING_SOURCE_RE.exec(String(text || '').trim());
    if (!m) return false;
    const label = String(m[1] || '').trim();
    if (!label || label.length > 40) return false;
    const key = label.toLowerCase().replace(/\s+/g, '');
    await pool.query(
      `INSERT INTO booking_source_answers (line_user_id, source_key, source_label, raw_text, answered_at)
       VALUES ($1, $2, $3, $4,
         CASE WHEN $5::double precision > 0 THEN TO_TIMESTAMP($5::double precision / 1000.0) ELSE now() END)
       ON CONFLICT DO NOTHING`,
      [lineUserId, key, label, String(text || '').slice(0, 300), Number(eventTimestamp || 0)]
    );
    return true;
  }

  async function rewardInviteForFollow(lineUserId, eventTimestamp) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rewardResult = await applyInviteFollowReward(client, {
        lineUserId,
        eventTimestamp,
        inviteBonusMax,
        inviteFriendsPerDraw
      });
      await client.query('COMMIT');
      return rewardResult;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- 關鍵字自動回覆 ----------
  // 撈 active 規則（574 好友量級，每次查 DB 可接受），priority 小的先比，第一條命中即回。
  async function matchKeywordRule(messageText) {
    const msg = String(messageText || '').trim();
    if (!msg) return null;
    const msgLower = msg.toLowerCase();
    const rs = await pool.query(
      `SELECT id, keywords, match_type, message_template_id
       FROM admin_keyword_replies
       WHERE is_active = true AND message_template_id IS NOT NULL
       ORDER BY priority ASC, id ASC`
    );
    for (const rule of rs.rows) {
      // 兜底規則（fallback）不在這裡比對：它是「所有關鍵字都沒命中」時的 catch-all，由 matchFallbackRule 處理
      if (rule.match_type === 'fallback') continue;
      const kws = String(rule.keywords || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      if (kws.length === 0) continue;
      const hit = rule.match_type === 'exact'
        ? kws.some(k => msgLower === k)
        : kws.some(k => msgLower.includes(k));
      if (hit) return rule;
    }
    return null;
  }

  // 兜底回覆：所有關鍵字都沒命中時，找一條 match_type='fallback' 的 active 規則當 catch-all。
  // 最多一條生效（priority 最小、其次 id 最小），keywords 內容忽略。
  async function matchFallbackRule() {
    const rs = await pool.query(
      `SELECT id, keywords, match_type, message_template_id
       FROM admin_keyword_replies
       WHERE is_active = true AND match_type = 'fallback' AND message_template_id IS NOT NULL
       ORDER BY priority ASC, id ASC
       LIMIT 1`
    );
    return rs.rows[0] || null;
  }

  // 公開網域（給訊息庫模板 hero 圖組 https 網址；同 flowEngine.getOrigin 的來源）
  function getKeywordReplyOrigin() {
    const o = process.env.LINE_PUSH_PUBLIC_BASE_URL || process.env.URL || process.env.PUBLIC_SITE_URL || '';
    return String(o).replace(/\/+$/, '');
  }

  async function replyKeywordTemplate(rule, replyToken, lineUserId) {
    if (!linePush || typeof linePush.replyLineMessages !== 'function') return false;
    const rs = await pool.query(
      'SELECT message_config FROM admin_message_templates WHERE id = $1',
      [rule.message_template_id]
    );
    if (rs.rowCount === 0) return false;
    // 按鈕改指到記名跳板：這樣才知道「誰點了這則關鍵字回覆的按鈕」，
    // 拿得到人才能貼標籤、之後打這一包人。模板訊息與自訂 Flex 訊息都吃得下；
    // 本來就指向自家頁面的按鈕不包（那種頁面自己認得出是誰）。
    // 沒設 LIFF、或包的過程出任何狀況，就用原本的設定——訊息一定要發得出去。
    const cfg = rs.rows[0].message_config;
    const liffId = process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';
    let useCfg = cfg;
    try {
      useCfg = withMessageTracking(cfg, { source: 'keyword', refId: String(rule.id), liffId }) || cfg;
    } catch (e) { console.error('keyword reply tracking wrap failed:', e && e.message); useCfg = cfg; }
    const built = buildLineMessages(useCfg, { heroImageBaseUrl: getKeywordReplyOrigin() });
    if (!built.ok) return false;
    return await linePush.replyLineMessages(replyToken, built.messages, {
      lineUserId: lineUserId || null,
      pushType: 'keyword_reply'
    });
  }

  return async function lineWebhookHandler(req, res) {
    try {
      if (!channelSecret) {
        return res.status(500).send('Missing LINE channel secret');
      }

      const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const rawBody = rawBodyBuffer.toString('utf8');
      const expectedSignature = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
      const incomingSignature = req.get('x-line-signature') || '';
      if (!safeEqualBase64(expectedSignature, incomingSignature)) {
        return res.status(401).send('Invalid signature');
      }

      const payload = JSON.parse(rawBody || '{}');
      const events = Array.isArray(payload.events) ? payload.events : [];
      for (const event of events) {
        // 封鎖：標記 blocked_at（給流失分眾 + 抑制發送）
        if (event?.type === 'unfollow') {
          const blockedUid = event?.source?.userId || null;
          if (blockedUid) {
            try { await pool.query(`UPDATE users SET blocked_at = now() WHERE line_user_id = $1`, [blockedUid]); }
            catch (e) { console.error('mark blocked failed:', e.message); }
          }
          await appendWebhookEventLog({
            eventType: 'unfollow', lineUserId: blockedUid, result: 'blocked',
            detail: '用戶封鎖 OA', eventTimestamp: event?.timestamp, rawEvent: event || {}
          });
          continue;
        }
        // 圖文選單分頁切換（richmenuswitch 的 postback）：記一筆行為，不回話
        if (event?.type === 'postback') {
          const data = String(event?.postback?.data || '');
          const mTab = /^rmtab\|(\d+)\|(\d+)$/.exec(data);
          if (mTab) {
            await pool.query(
              `INSERT INTO rich_menu_taps (menu_id, tab, cell, kind, label, line_user_id)
               VALUES ($1, $2, NULL, 'tab', NULL, $3)`,
              [Number(mTab[1]), Number(mTab[2]), event?.source?.userId || null]
            ).catch(e => console.error('richmenu tab tap log failed:', e.message));
          }
          continue;
        }

        // 任何 message 事件（含圖片/貼圖）都先把人收進 users 會員表。
        // 為什麼需要：LINE 只在「加好友當下」送 follow 事件，在本 webhook 建立之前就已經加過好友的
        // 舊好友永遠不會再有 follow 事件；若只靠 follow 收人，他們就算天天傳訊息也永遠不在會員表，
        // 不會出現在名單與群發受眾裡（實際案例：只傳過訊息、從無 follow 事件的用戶）。
        if (event?.type === 'message' && event?.source?.userId) {
          try { await captureUserFromMessage(event.source.userId); }
          catch (e) { console.error('capture user from message failed:', e.message); }
          // 訂位來源調查：使用者點圖文選單的「透過 OpenRice 訂位／透過 Google 預訂」等選項時記下來。
          // 記錄後不中斷流程，關鍵字回覆等後續邏輯照常運作。
          if (event?.message?.type === 'text') {
            try { await captureBookingSource(event.source.userId, event.message.text, event.timestamp); }
            catch (e) { console.error('capture booking source failed:', e.message); }
          }
        }
        // 文字訊息：關鍵字自動回覆（reply token 一次性；本 webhook 僅此路徑使用 replyToken）
        // 任何失敗 try/catch 吞掉，絕不讓整批 webhook 回 500（同 reward_exception → continue 原則）
        if (event?.type === 'message' && event?.message?.type === 'text' && event?.replyToken) {
          // 指令 /whatsmyid：回報使用者自己的 LINE user ID（供後台設定 GM_USER_ID、鎖定測試對象用）。
          // 必須放在關鍵字比對之前短路：① 不會被某條 contains 規則誤攔 ② 省一次 DB 查詢
          // ③ replyToken 一次性，回覆後 continue，避免下面關鍵字回覆重用同一 token 而被 LINE 回 400。
          const cmdText = String(event?.message?.text || '').trim().toLowerCase();
          if (cmdText === '/whatsmyid') {
            const uid = event?.source?.userId || '';
            const replyText = uid
              ? '你的 LINE user ID：\n' + uid + '\n\n（可長按上面這串文字複製）'
              : '抱歉，這裡取不到你的 user ID（可能是在群組或聊天室中）。請在與官方帳號的一對一聊天視窗再輸入一次 /whatsmyid。';
            let widSent = false;
            try {
              if (linePush && typeof linePush.replyLineMessages === 'function') {
                widSent = await linePush.replyLineMessages(event.replyToken, [replyText], {
                  lineUserId: uid || null,
                  pushType: 'whatsmyid'
                });
              }
            } catch (widErr) {
              console.error('whatsmyid reply failed:', widErr.message);
            }
            // 比照下方關鍵字分支：依實際送出結果記 log，reply 失敗（token 過期／缺 access token／API 錯誤）記 failed，
            // 避免維運者在 line_webhook_events 看到 replied 卻其實沒送出。
            await appendWebhookEventLog({
              eventType: 'message',
              lineUserId: uid || null,
              result: !uid ? 'whatsmyid_no_userid' : (widSent ? 'whatsmyid_replied' : 'whatsmyid_reply_failed'),
              detail: uid || null,
              eventTimestamp: event?.timestamp,
              rawEvent: event || {}
            }).catch(() => {});
            continue;
          }
          // 金豬食堂正式訂位服務：只處理精確指令，並在關鍵字規則前短路，
          // 避免一次性的 replyToken 被其他自動回覆重複使用。
          if (goldPigBookings && typeof goldPigBookings.handleCommand === 'function') {
            try {
              const bookingReply = await goldPigBookings.handleCommand(
                event.source.userId,
                event.message.text
              );
              if (bookingReply) {
                const sent = linePush && typeof linePush.replyLineMessages === 'function'
                  ? await linePush.replyLineMessages(event.replyToken, bookingReply.messages, {
                    lineUserId: event.source.userId,
                    pushType: 'gold_pig_booking'
                  })
                  : false;
                await appendWebhookEventLog({
                  eventType: 'message',
                  lineUserId: event.source.userId,
                  result: sent ? bookingReply.result : `${bookingReply.result}_reply_failed`,
                  detail: null,
                  eventTimestamp: event?.timestamp,
                  rawEvent: event || {}
                }).catch(() => {});
                continue;
              }
            } catch (bookingErr) {
              console.error('gold pig booking command failed:', bookingErr.message);
              await appendWebhookEventLog({
                eventType: 'message',
                lineUserId: event.source.userId,
                result: 'gold_pig_booking_exception',
                detail: String(bookingErr.message || bookingErr).slice(0, 500),
                eventTimestamp: event?.timestamp,
                rawEvent: event || {}
              }).catch(() => {});
              continue;
            }
          }
          // 訂位抽獎：圖文選單「登記抽獎」按鍵（送出文字）→ 期間感知的說明。
          // 與手機登記同放在關鍵字比對之前短路（replyToken 一次性）。
          // 只在一對一聊天觸發：登記綁個人身分，群組裡傳手機號碼不該被當成登記。
          const isOneOnOne = event?.source?.type === 'user';
          // 圖文選單「發送文字」按鍵的行為記錄：比對已發布選單的按鍵文字。
          // 手動打出一樣的字也會被算進去——對成效統計來說是同一個觸發，可接受。
          if (isOneOnOne) {
            try {
              const now = Date.now();
              if (!globalThis.__rmBtnCache || now - globalThis.__rmBtnCache.at > 60000) {
                // 同一段文字可能出現在好幾個已發布選單上；訊息事件分不出用戶按的是哪個。
                // 排序讓「現役預設選單」最後蓋進 map ＝ 同字歸因給現役那個，
                // 統計至少穩定偏向大家實際看得到的選單，不會隨機記到備用選單頭上。
                const { rows: pubs } = await pool.query(
                  `SELECT id, published_config FROM rich_menus
                    WHERE status='published' AND published_config IS NOT NULL
                    ORDER BY is_default ASC, published_at ASC NULLS FIRST LIMIT 30`);
                const map = new Map();
                for (const r of pubs) {
                  const tabsArr = Array.isArray(r.published_config.tabs) && r.published_config.tabs.length
                    ? r.published_config.tabs
                    : [{ buttons: r.published_config.buttons || [] }];
                  tabsArr.forEach((t, ti) => (t.buttons || []).forEach((b, ci) => {
                    if (b && b.action && b.action.type === 'message' && b.action.text) {
                      map.set(String(b.action.text).trim(), { menu: r.id, tab: ti, cell: ci, label: b.label || null });
                    }
                  }));
                }
                globalThis.__rmBtnCache = { at: now, map };
              }
              const hit = globalThis.__rmBtnCache.map.get(String(event.message.text || '').trim());
              if (hit) {
                await pool.query(
                  `INSERT INTO rich_menu_taps (menu_id, tab, cell, kind, label, line_user_id)
                   VALUES ($1,$2,$3,'message',$4,$5)`,
                  [hit.menu, hit.tab, hit.cell, hit.label, event.source.userId || null]);
              }
            } catch (e) { console.error('richmenu msg tap log failed:', e.message); }
          }
          // 打活動名稱（例如「分享超有哩」）就回那個遊戲的卡片。
          // 用活動名稱當關鍵字＝以後開新活動不用改程式，取好名字就能用。
          const typed = String(event.message.text || '').trim();
          if (isOneOnOne && typed.length >= 2 && typed.length <= 40) {
            let game = null;
            try {
              const { rows } = await pool.query(
                `SELECT slug, name, description, game_type, cover_image_url, liff_id_override
                   FROM activities
                  WHERE status = 'active' AND game_type <> 'mgm' AND name = $1
                    AND (start_at IS NULL OR start_at <= now())
                    AND (end_at IS NULL OR end_at >= now())
                  ORDER BY id DESC LIMIT 1`, [typed]);
              game = rows[0] || null;
            } catch (e) { console.error('game keyword lookup failed:', e.message); }
            if (game) {
              const gameLiff = game.liff_id_override || process.env.GAMES_LIFF_ID ||
                               process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';
              const url = 'https://liff.line.me/' + gameLiff + '/' + game.game_type + '/' +
                          encodeURIComponent(game.slug);
              const bubble = {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', contents: [
                  { type: 'text', text: game.name, weight: 'bold', size: 'lg', wrap: true, color: '#3E2723' },
                  { type: 'text', text: String(game.description || '點下面的按鈕開始玩'), size: 'sm', wrap: true, color: '#8D6E63' }
                ]},
                footer: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
                  { type: 'button', style: 'primary', color: '#F15A22', height: 'sm',
                    action: { type: 'uri', label: '馬上玩', uri: url } }
                ]}
              };
              if (game.cover_image_url && /^https:\/\//.test(game.cover_image_url)) {
                bubble.hero = { type: 'image', url: game.cover_image_url, size: 'full',
                                aspectRatio: '20:13', aspectMode: 'cover' };
              }
              let sent = false;
              try {
                sent = await linePush.replyLineMessages(event.replyToken,
                  [{ type: 'flex', altText: game.name, contents: bubble }],
                  { lineUserId: event.source.userId, pushType: 'game_entry' });
              } catch (e) { console.error('game entry reply failed:', e.message); }
              await appendWebhookEventLog({
                eventType: 'message', lineUserId: event.source.userId,
                result: sent ? 'game_entry_replied' : 'game_entry_reply_failed', detail: game.slug,
                rawEvent: event
              });
              if (sent) continue;
            }
          }
          if (isOneOnOne && await handleBookingRegKeyword(event.source.userId, event.message.text, event.replyToken)) {
            await appendWebhookEventLog({
              eventType: 'message', lineUserId: event.source.userId,
              result: 'booking_reg_prompt', detail: null,
              eventTimestamp: event?.timestamp, rawEvent: event || {}
            }).catch(() => {});
            continue;
          }
          // 訂位抽獎資格登記：使用者直接輸入手機號碼就當作登記。
          // 放在關鍵字比對之前短路，避免被某條 contains 規則吃掉；回覆後 continue
          // （replyToken 一次性，不 continue 會被下面的關鍵字回覆重用而被 LINE 回 400）。
          const phoneOutcome = isOneOnOne
            ? await captureBookingPhone(event.source.userId, event.message.text, event.replyToken)
            : false;
          if (phoneOutcome) {
            await appendWebhookEventLog({
              eventType: 'message', lineUserId: event.source.userId,
              result: 'booking_phone_' + phoneOutcome, detail: null,
              eventTimestamp: event?.timestamp, rawEvent: event || {}
            }).catch(() => {});
            continue;
          }
          let krResult = 'keyword_no_match';
          let krDetail = null;
          try {
            // 先比對一般關鍵字規則；都沒命中再退到兜底（fallback）規則
            const rule = await matchKeywordRule(event?.message?.text) || await matchFallbackRule();
            if (rule) {
              const sent = await replyKeywordTemplate(rule, event.replyToken, event?.source?.userId || null);
              const isFallback = rule.match_type === 'fallback';
              krResult = sent
                ? (isFallback ? 'keyword_fallback_replied' : 'keyword_replied')
                : (isFallback ? 'keyword_fallback_reply_failed' : 'keyword_reply_failed');
              krDetail = ((isFallback ? 'fallback rule#' : 'rule#') + rule.id + ' keywords=' + String(rule.keywords || '')).slice(0, 300);
              if (sent) {
                // 命中次數 +1：fire-and-forget，失敗不影響回覆
                pool
                  .query('UPDATE admin_keyword_replies SET hit_count = hit_count + 1, updated_at = now() WHERE id = $1', [rule.id])
                  .catch(e => console.error('keyword reply hit_count update failed:', e.message));
              }
            }
          } catch (krErr) {
            krResult = 'keyword_reply_exception';
            krDetail = String(krErr.message || krErr).slice(0, 800);
            console.error('keyword reply failed:', krErr.message);
          }
          await appendWebhookEventLog({
            eventType: 'message',
            lineUserId: event?.source?.userId || null,
            result: krResult,
            detail: krDetail,
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          }).catch(() => {});
          continue;
        }
        if (event?.type !== 'follow') {
          await appendWebhookEventLog({
            eventType: event?.type || 'unknown',
            lineUserId: event?.source?.userId || null,
            result: 'ignored_event_type',
            detail: '非 follow/unfollow 事件（仍記 log）',
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          });
          continue;
        }
        const lineUserId = event?.source?.userId;
        if (!lineUserId) {
          await appendWebhookEventLog({
            eventType: 'follow',
            lineUserId: null,
            result: 'missing_user_id',
            detail: 'Follow event without source.userId.',
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          });
          continue;
        }
        let isFirstFollow = false; // 見面禮只發「真的第一次加入」的人（退追再加不算，防洗）
        // 加好友（含重新加好友）：抓 LINE 個人檔案（暱稱+大頭貼），把這個 follower 寫進 users 表。
        // 沒有這一步，透過活動以外管道（掃 QR、搜尋 OA）加入的好友只會有 line_user_id、
        // 沒有暱稱/大頭貼，「全部會員」群發也會漏掉他們。用 line_user_id 當唯一鍵 upsert：
        //   - username = 'line_' + userId（滿足 NOT NULL 且不與春日帳號衝突）
        //   - password_hash = ''（NOT NULL；這種好友不走密碼登入，空字串 = 無法登入）
        //   - 已存在則更新暱稱/大頭貼並清除封鎖標記（重新加好友）
        try {
          let prof = null;
          try { prof = await fetchOaProfile(lineUserId); }
          catch (e) { console.error('fetchOaProfile failed:', e.message); }
          const upsertRs = await pool.query(
            `INSERT INTO users (username, password_hash, line_user_id, line_display_name, line_picture_url, blocked_at, created_at)
             VALUES ($1, '', $2, $3, $4, NULL, now())
             ON CONFLICT (line_user_id) DO UPDATE SET
               line_display_name = COALESCE(EXCLUDED.line_display_name, users.line_display_name),
               line_picture_url  = COALESCE(EXCLUDED.line_picture_url, users.line_picture_url),
               blocked_at = NULL
             RETURNING (xmax = 0) AS inserted`,
            ['line_' + lineUserId, lineUserId, prof && prof.displayName, prof && prof.pictureUrl]
          );
          isFirstFollow = !!(upsertRs.rows[0] && upsertRs.rows[0].inserted);
        } catch (e) { console.error('follow user upsert failed:', e.message); }
        let rewardResult;
        try {
          rewardResult = await rewardInviteForFollow(lineUserId, event.timestamp);
        } catch (rewardErr) {
          await appendWebhookEventLog({
            eventType: 'follow',
            lineUserId,
            result: 'reward_exception',
            detail: String(rewardErr.message || rewardErr).slice(0, 800),
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          }).catch(() => {});
          // 不要 throw：否則整批 webhook 回 500 → LINE 重送整批 → 批內已成功的 follow
          // 會重複觸發 enroll/推播。單一事件失敗就跳過，整體仍回 200。
          continue;
        }
        const resultCode = rewardResult?.result || 'processed';
        let logDetail = null;
        if (resultCode === 'no_matching_invite') {
          const staticHint =
            '找不到可更新的邀請列。請確認：①好友已用 LINE 開啟「你的邀請連結」並登入（會寫入 line_invites）後再加官方帳 ②Hosting 的 DATABASE_URL 與你在 Supabase 看的為同一資料庫 ③部署最新程式後請封鎖再重加官方帳以重送 follow。';
          logDetail = rewardResult?.detail
            ? `${rewardResult.detail} ${staticHint}`
            : staticHint;
        }
        await appendWebhookEventLog({
          eventType: 'follow',
          lineUserId,
          inviteId: rewardResult?.inviteId || null,
          inviterUserId: rewardResult?.inviterUserId || null,
          result: resultCode,
          detail: logDetail,
          eventTimestamp: event?.timestamp,
          rawEvent: event || {}
        });

        // 自動化流程：觸發 follow-flows（取代舊的寫死 D0；歡迎訊息改由流程系統發）
        // 必須 await：serverless（Lambda）在 response 送出後會凍結，未 await 的背景工作可能丟失
        // → 新好友收不到歡迎流程。enrollUser 已用 ON CONFLICT 去重，重送 webhook 安全。
        if (flowEngine && typeof flowEngine.triggerFollow === 'function') {
          try { await flowEngine.triggerFollow(lineUserId, null); }
          catch (e) { console.error('flow follow trigger failed:', e.message); }
        }

        // 揪友賺哩：新好友見面禮（引擎自己冪等——重加好友不會重發也不再吵他）。
        // 同樣必須 await；失敗只記 log，不影響 follow 主流程。
        if (mgmEngine && typeof mgmEngine.onFollow === 'function') {
          try { await mgmEngine.onFollow(lineUserId, null, isFirstFollow); } // 顯示名後台會 JOIN users 補
          catch (e) { console.error('mgm onFollow failed:', e.message); }
        }

        if (rewardResult?.result === 'rewarded' && linePush && typeof linePush.pushLineMessages === 'function') {
          try {
            const payload = await buildInviteRewardPushMessages({
              rewardResult,
              friendsPerDraw,
              liffLotteryPushUrl,
              linePushImageBaseCandidates
            });
            if (payload) await linePush.pushLineMessages(payload.inviterLineUserId, payload.messages, payload.pushExtras);
          } catch (err) {
            console.error('LINE invite reward push failed:', err.message);
          }
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('LINE webhook error:', err.message);
      return res.status(500).json({ ok: false });
    }
  };
}

module.exports = { createLineWebhookHandler };
