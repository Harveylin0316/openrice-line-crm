const crypto = require('crypto');
const { applyInviteFollowReward } = require('../core/inviteReward');
const { buildInviteRewardPushMessages } = require('../core/inviteRewardPushMessages');
const { buildLineMessages } = require('../core/broadcastTemplates');
const { fetchOaProfile } = require('../core/oaFollower');

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
  flowEngine = null
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
    const built = buildLineMessages(rs.rows[0].message_config, { heroImageBaseUrl: getKeywordReplyOrigin() });
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
        // 任何 message 事件（含圖片/貼圖）都先把人收進 users 會員表。
        // 為什麼需要：LINE 只在「加好友當下」送 follow 事件，在本 webhook 建立之前就已經加過好友的
        // 舊好友永遠不會再有 follow 事件；若只靠 follow 收人，他們就算天天傳訊息也永遠不在會員表，
        // 不會出現在名單與群發受眾裡（實際案例：只傳過訊息、從無 follow 事件的用戶）。
        if (event?.type === 'message' && event?.source?.userId) {
          try { await captureUserFromMessage(event.source.userId); }
          catch (e) { console.error('capture user from message failed:', e.message); }
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
          await pool.query(
            `INSERT INTO users (username, password_hash, line_user_id, line_display_name, line_picture_url, blocked_at, created_at)
             VALUES ($1, '', $2, $3, $4, NULL, now())
             ON CONFLICT (line_user_id) DO UPDATE SET
               line_display_name = COALESCE(EXCLUDED.line_display_name, users.line_display_name),
               line_picture_url  = COALESCE(EXCLUDED.line_picture_url, users.line_picture_url),
               blocked_at = NULL`,
            ['line_' + lineUserId, lineUserId, prof && prof.displayName, prof && prof.pictureUrl]
          );
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
