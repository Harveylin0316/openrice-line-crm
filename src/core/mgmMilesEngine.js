/**
 * 揪友賺哩（MGM）引擎 — 獨立模組，不與其他後台功能共用邏輯。
 *
 * 設計（Hen 拍板）：
 *   - 里數「當成獎品」：達標就把對應獎品直接寫進 activity_plays（現有中獎帳本），
 *     人工發放沿用得獎名單匯出，不另建里數帳本
 *   - 階梯：加入送見面禮里數 → 每揪滿 per_friends 位送里數 → 揪滿 wheel_friends 位
 *     記一筆大獎抽獎資格（寫進 activity_plays，不發遊戲）
 *   - 被推薦來的新友也送見面禮（他就是新好友，走同一條 follow 路徑）
 *   - 所有參數放 activities.rules.mgm（後台可調，不寫死）
 *
 * 冪等：每一筆發放都帶唯一鍵（DB unique index 擋重複），webhook 重送/併發安全。
 * 失敗策略：發放失敗只記 log 絕不 throw——不能讓 MGM 把 follow 流程炸掉。
 */

const CARD_COLOR = '#F15A22';

function createMgmMilesEngine({ query, linePush, liffId }) {

  /** 讀取進行中的 MGM 活動設定（一次一檔；沒有進行中的回 null） */
  async function loadActiveCampaign() {
    try {
      const { rows } = await query(
        `SELECT id, slug, name, status, start_at, end_at, rules
           FROM activities
          WHERE game_type = 'mgm' AND status = 'active'
            AND (start_at IS NULL OR start_at <= now())
            AND (end_at IS NULL OR end_at >= now())
          ORDER BY id DESC LIMIT 1`
      );
      if (rows.length === 0) return null;
      return normalizeCampaign(rows[0]);
    } catch (e) {
      console.error('mgm loadActiveCampaign failed:', e.message);
      return null;
    }
  }

  /** 依 slug 讀取（landing 頁用，draft 也讀得到以便上線前預覽） */
  async function loadCampaignBySlug(slug) {
    try {
      const { rows } = await query(
        `SELECT id, slug, name, status, start_at, end_at, rules
           FROM activities WHERE game_type = 'mgm' AND slug = $1 LIMIT 1`,
        [slug]
      );
      if (rows.length === 0) return null;
      return normalizeCampaign(rows[0]);
    } catch (e) {
      console.error('mgm loadCampaignBySlug failed:', e.message);
      return null;
    }
  }

  function normalizeCampaign(row) {
    const m = (row.rules && row.rules.mgm) || {};
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      start_at: row.start_at,
      end_at: row.end_at,
      welcomeMiles: numOr(m.welcome_miles, 100),          // 加入送幾里（0 = 不送）
      perFriends: Math.max(1, numOr(m.per_friends, 2)),   // 每揪滿幾位
      perMiles: numOr(m.per_miles, 100),                  // 送幾里
      wheelFriends: Math.max(1, numOr(m.wheel_friends, 4)), // 揪滿幾位送轉盤
      milesCap: numOr(m.miles_cap, 0),                    // 整檔里數上限（0 = 不限）
      repeatLadder: !!m.repeat_ladder,                    // 4 位之後每 per_friends 位要不要繼續送里
      shareTitle: String(m.share_title || row.name || '揪友賺哩'),
      shareText: String(m.share_text || '加入 OpenRice 官方帳號，一起拿「亞洲萬里通」里數'),
      shareImage: String(m.share_image || ''),            // 分享卡片圖（朋友在聊天室看到的）
      cardImage: String(m.card_image || ''),              // 推播卡通用圖（下面沒設就用這張）
      welcomeImage: String(m.welcome_image || ''),        // 見面禮卡專用
      milestoneImage: String(m.milestone_image || ''),    // 達標卡專用
      wheelImage: String(m.wheel_image || ''),            // 抽獎卡專用
      landingImage: String(m.landing_image || ''),        // 活動頁頂部橫幅
      // 測試名單：非空 = 測試模式，只有名單上的人玩得到，其他人完全看不到也收不到卡
      testUids: Array.isArray(m.test_uids)
        ? m.test_uids.filter(u => /^U[0-9a-f]{32}$/i.test(String(u))).slice(0, 50)
        : []
    };
  }

  /** 測試模式判定：名單空 = 全員開放；非空 = 只有名單上的人 */
  function isTester(campaign, uid) {
    if (!campaign.testUids || campaign.testUids.length === 0) return true;
    return campaign.testUids.includes(uid);
  }

  function numOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  }

  /** 找到「N 里」對應的獎品列（獎品名含里數即可；找不到回 null，發放會略過並大聲記 log） */
  async function findMilesPrize(campaign, miles) {
    const { rows } = await query(
      `SELECT id, name, description, prize_type, prize_value, image_url, is_grand_prize
         FROM activity_prizes
        WHERE activity_id = $1 AND (prize_value->>'miles')::int = $2
        ORDER BY id LIMIT 1`,
      [campaign.id, miles]
    );
    return rows[0] || null;
  }

  /** 整檔已發出的總里數（成本上限用） */
  async function totalMilesGranted(campaign) {
    const { rows } = await query(
      `SELECT COALESCE(SUM((prize_snapshot->>'miles')::int), 0)::int AS total
         FROM activity_plays
        WHERE activity_id = $1 AND prize_snapshot->>'miles' IS NOT NULL`,
      [campaign.id]
    );
    return Number(rows[0].total || 0);
  }

  /**
   * 發里數：把獎品寫進 activity_plays（唯一鍵 mgm_key 擋重複）。
   * 回 'granted' | 'duplicate' | 'cap_reached' | 'no_prize' | 'error'
   */
  async function grantMiles(campaign, lineUserId, miles, milestoneKey, displayName) {
    try {
      if (campaign.milesCap > 0) {
        const total = await totalMilesGranted(campaign);
        if (total + miles > campaign.milesCap) {
          console.warn('mgm miles cap reached:', campaign.slug, total, '+', miles, '>', campaign.milesCap);
          return 'cap_reached';
        }
      }
      const prize = await findMilesPrize(campaign, miles);
      if (!prize) {
        console.error('mgm: 找不到 ' + miles + ' 里的獎品（activity_prizes 要有一筆 prize_value.miles=' + miles + '）');
        return 'no_prize';
      }
      const mgmKey = 'mgm:' + campaign.slug + ':' + milestoneKey + ':' + lineUserId;
      const snapshot = {
        name: prize.name, description: prize.description, prize_type: prize.prize_type,
        image_url: prize.image_url, is_grand_prize: prize.is_grand_prize,
        miles: miles, milestone: milestoneKey
      };
      const ins = await query(
        `INSERT INTO activity_plays (activity_id, line_user_id, line_display_name, prize_id, prize_snapshot, properties)
         SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM activity_plays WHERE properties->>'mgm_key' = $7)
         RETURNING id`,
        [campaign.id, lineUserId, displayName || null, prize.id,
         JSON.stringify(snapshot), JSON.stringify({ mgm_key: mgmKey, milestone: milestoneKey }), mgmKey]
      );
      return ins.rows.length > 0 ? 'granted' : 'duplicate';
    } catch (e) {
      // unique index 撞到也會走到這（併發下 WHERE NOT EXISTS 可能同過）→ 當 duplicate
      if (String(e.message || '').includes('uq_plays_mgm_key')) return 'duplicate';
      console.error('mgm grantMiles failed:', e.message);
      return 'error';
    }
  }

  /** 記一筆「大獎抽獎資格」（activity_plays，mgm_key 冪等）。
   *  不發遊戲、不綁任何轉盤活動——只留紀錄再推通知，實際抽獎由行銷另外辦。 */
  async function grantDrawTicket(campaign, lineUserId, milestoneKey) {
    try {
      const mgmKey = 'mgm:' + campaign.slug + ':' + milestoneKey + ':' + lineUserId;
      const snapshot = { kind: 'draw_ticket', name: '大獎抽獎資格', milestone: milestoneKey };
      const ins = await query(
        `INSERT INTO activity_plays (activity_id, line_user_id, line_display_name, prize_snapshot, properties)
         SELECT $1, $2, NULL, $3::jsonb, $4::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM activity_plays WHERE properties->>'mgm_key' = $5)
         RETURNING id`,
        [campaign.id, lineUserId, JSON.stringify(snapshot),
         JSON.stringify({ mgm_key: mgmKey, milestone: milestoneKey, kind: 'draw_ticket' }), mgmKey]
      );
      return ins.rows.length > 0 ? 'granted' : 'duplicate';
    } catch (e) {
      if (String(e.message || '').includes('uq_plays_mgm_key')) return 'duplicate';
      console.error('mgm grantDrawTicket failed:', e.message);
      return 'error';
    }
  }

  function milestoneSafe(k) { return String(k).slice(0, 40); }

  /** 這個人已成功揪到幾位「新朋友」。
   *  只算 invitee_was_existing = false：既有好友互點連結不計獎（里數是真成本，
   *  否則 660 位老友互洗就能白拿），退追再加回來也不算新（users 列不會被刪）。 */
  async function referralCount(campaign, inviterId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c FROM activity_referrals
        WHERE activity_id = $1 AND inviter_line_user_id = $2
          AND invitee_was_existing IS FALSE`,
      [campaign.id, inviterId]
    );
    return Number(rows[0].c || 0);
  }

  // ── 推播卡片 ──────────────────────────────────────────────────
  function joinUrl(campaign, refUid) {
    const base = 'https://liff.line.me/' + (liffId || '') + '/mgm/' + encodeURIComponent(campaign.slug);
    return refUid ? base + '?ref=' + encodeURIComponent(refUid) : base;
  }

  /** 簡單的圖+文+按鈕 flex 卡（有圖用圖，沒圖純文卡）。
   *  image 可指定該張卡專屬圖；沒給就退回 campaign.cardImage */
  function buildCard(campaign, { title, body, buttonLabel, buttonUrl, image }) {
    const bubble = {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color: '#3E2723' },
          { type: 'text', text: body, size: 'sm', wrap: true, color: '#8D6E63' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [{
          type: 'button', style: 'primary', color: CARD_COLOR, height: 'sm',
          action: { type: 'uri', label: buttonLabel, uri: buttonUrl }
        }]
      }
    };
    const heroUrl = image || campaign.cardImage;
    if (heroUrl && /^https:\/\//.test(heroUrl)) {
      bubble.hero = { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
    }
    return { type: 'flex', altText: title, contents: bubble };
  }

  async function pushCard(lineUserId, card, pushType) {
    try {
      if (!linePush || typeof linePush.pushLineMessages !== 'function') return false;
      return await linePush.pushLineMessages(lineUserId, [card], { pushType: pushType });
    } catch (e) {
      console.error('mgm push failed:', e.message);
      return false;
    }
  }

  // ── 對外三個掛點 ─────────────────────────────────────────────

  /**
   * 新好友加入（webhook follow 呼叫，必須 await）。
   * 見面禮 + 歡迎卡。冪等：重加好友不會再發（mgm_key 擋）。
   */
  async function onFollow(lineUserId, displayName, isNewFollower) {
    const campaign = await loadActiveCampaign();
    if (!campaign) return null;
    if (!isTester(campaign, lineUserId)) return null; // 測試模式：一般用戶什麼都不會發生
    // 見面禮只發「真的第一次加入」（既有好友退追再加不送——跟揪友同一套防洗邏輯）。
    // 測試模式下測試帳號放行，讓一個人也能重測 welcome 流程（重置後封鎖再解除即可）
    const allowWelcome = isNewFollower === true ||
      (campaign.testUids.length > 0 && isTester(campaign, lineUserId));
    let granted = null;
    if (campaign.welcomeMiles > 0 && allowWelcome) {
      granted = await grantMiles(campaign, lineUserId, campaign.welcomeMiles, 'welcome', displayName);
    }
    // 只有真的第一次發成功才推卡（重加好友不再吵他）
    if (granted === 'granted') {
      const card = buildCard(campaign, {
        title: '見面禮 ' + campaign.welcomeMiles + ' 里已幫你記下',
        body: '之後揪還沒加入官方帳號的朋友，每 ' + campaign.perFriends + ' 位新朋友再多 ' + campaign.perMiles +
          ' 里，滿 ' + campaign.wheelFriends + ' 位再多一個大獎抽獎資格。里數統一在活動結束後發放。',
        buttonLabel: '立即分享',
        buttonUrl: joinUrl(campaign, lineUserId),
        image: campaign.welcomeImage
      });
      await pushCard(lineUserId, card, 'mgm_welcome');
    }
    return { campaign: campaign.slug, welcome: granted };
  }

  /**
   * 邀請成功入帳後呼叫（referral 路由 counted 之後，必須 await）。
   * 檢查里程碑：每 perFriends 位 → 里數；wheelFriends 位 → 轉盤一次。
   */
  async function onReferralCounted(campaign, inviterId) {
    if (!isTester(campaign, inviterId)) return []; // 測試模式：非測試者不發獎
    const count = await referralCount(campaign, inviterId);
    const results = [];

    // 里數里程碑：照行銷流程圖，抽獎門檻那一級「只送抽獎」不疊里數
    // → 里數只在低於門檻的倍數發（per=2、wheel=4 時：2位→100里、4位→抽獎）
    if (campaign.perMiles > 0 && count > 0 && count % campaign.perFriends === 0) {
      const withinLadder = campaign.repeatLadder || count < campaign.wheelFriends;
      if (withinLadder) {
        const r = await grantMiles(campaign, inviterId, campaign.perMiles, 'm' + count, null);
        results.push({ milestone: 'm' + count, kind: 'miles', result: r });
        if (r === 'granted') {
          const card = buildCard(campaign, {
            title: '恭喜獲 ' + campaign.perMiles + ' 里！',
            body: '你已成功揪到 ' + count + ' 位新朋友。繼續分享，滿 ' + campaign.wheelFriends + ' 位就有大獎抽獎資格。',
            buttonLabel: '立即分享',
            buttonUrl: joinUrl(campaign, inviterId),
            image: campaign.milestoneImage
          });
          await pushCard(inviterId, card, 'mgm_milestone');
        }
      }
    }

    // 抽獎資格里程碑：只通知「你有資格了」，不給遊戲、不連任何轉盤
    if (count === campaign.wheelFriends) {
      const r = await grantDrawTicket(campaign, inviterId, 'wheel' + count);
      results.push({ milestone: 'wheel' + count, kind: 'draw_ticket', result: r });
      if (r === 'granted') {
        const card = buildCard(campaign, {
          title: '恭喜！你已取得抽獎資格',
          body: '你已成功揪到 ' + count + ' 位新朋友，取得大獎抽獎資格。' +
                '我們會在活動結束後抽出得獎者並主動通知你。',
          buttonLabel: '繼續分享',
          buttonUrl: joinUrl(campaign, inviterId),
          image: campaign.wheelImage
        });
        await pushCard(inviterId, card, 'mgm_draw_ticket');
      }
    }
    return results;
  }

  /** 舊友入口：回覆分享卡（webhook 關鍵字「揪友賺哩」用；回 reply 用的 messages 陣列） */
  async function buildEntryCard(lineUserId) {
    const campaign = await loadActiveCampaign();
    if (!campaign) return null;
    if (!isTester(campaign, lineUserId)) return null; // 測試模式：交還給一般關鍵字規則
    return [buildCard(campaign, {
      title: campaign.shareTitle,
      body: '每揪 ' + campaign.perFriends + ' 位新朋友加入官方帳號，送 ' + campaign.perMiles +
        ' 里；滿 ' + campaign.wheelFriends + ' 位再多一個大獎抽獎資格（已是好友的不算）。',
      buttonLabel: '立即分享',
      buttonUrl: joinUrl(campaign, lineUserId),
      image: campaign.cardImage || campaign.shareImage
    })];
  }

  return {
    isTester,
    loadActiveCampaign,
    loadCampaignBySlug,
    grantMiles,
    grantDrawTicket,
    referralCount,
    onFollow,
    onReferralCounted,
    buildEntryCard,
    buildCard,
    joinUrl,
    totalMilesGranted
  };
}

module.exports = { createMgmMilesEngine };
