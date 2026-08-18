/**
 * 揪友賺哩（MGM）— 獨立路由，不與其他後台頁面混用。
 *
 *  公開（LIFF）：
 *   GET  /games/mgm/:slug                 分享/進度 landing（LIFF 短網址 /mgm/:slug 會被
 *                                         /games/ dispatcher 轉到這裡）
 *   GET  /api/games/mgm/:slug/me          我的進度（揪了幾位、離下一階多遠）
 *   POST /api/games/mgm/:slug/referral    邀請入帳（被推薦人開頁時打）＋里程碑判定
 *
 *  後台（獨立頁）：
 *   GET  /admin/mgm                       揪友賺哩後台（設定 + 發放名單）
 *   GET  /admin/mgm/api/data              活動設定 + 統計 + 發放名單
 *   POST /admin/mgm/api/create            建一檔新活動（含預設獎品，draft）
 *   POST /admin/mgm/api/config            存設定（限管理員）
 *   POST /admin/mgm/api/mark-granted      批次標記「已發放」（人工入帳完成）
 */
const { registerReferral } = require('../core/gamePlayEngine');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');

function registerMgmMilesRoutes(app, deps) {
  const { query, authCore, mgmEngine, defaultLiffId } = deps;
  const { requireAdmin, requireOwner } = authCore;
  const jsonErr = (res, s, e, extra = {}) => res.status(s).json({ ok: false, error: e, ...extra });

  // 身分驗證：比照遊戲頁——一律以 id token 的 sub 為準（LIFF_TOKEN_ENFORCE=0 才放行裸 uid）
  async function verifyIdentity(claimedUid, idToken) {
    const enforce = process.env.LIFF_TOKEN_ENFORCE !== '0';
    if (!idToken) {
      return enforce
        ? { pass: false, reject: { status: 401, code: 'token_required', detail: '登入憑證遺失，請關閉後從 LINE 重新開啟此頁。' } }
        : { pass: true, uid: claimedUid };
    }
    const channelId = channelIdFromLiffId(defaultLiffId || '');
    let v;
    try { v = await verifyLiffIdToken(idToken, channelId); }
    catch (e) { v = { ok: false }; }
    if (!enforce) return { pass: true, uid: claimedUid };
    if (!v.ok || !v.sub) return { pass: false, reject: { status: 401, code: 'token_invalid', detail: '身分驗證失敗，請重新開啟頁面。' } };
    if (claimedUid && v.sub !== claimedUid) return { pass: false, reject: { status: 403, code: 'identity_mismatch', detail: '身分不符。' } };
    return { pass: true, uid: v.sub };
  }

  function logAttempt(slug, inviterId, inviteeId, outcome) {
    query(
      `INSERT INTO activity_referral_attempts (activity_slug, game_type, inviter_line_user_id, invitee_line_user_id, outcome)
       VALUES ($1, 'mgm', $2, $3, $4)`,
      [slug, inviterId || null, inviteeId || null, String(outcome || 'unknown').slice(0, 60)]
    ).catch(e => console.error('mgm attempt log failed:', e.message));
  }

  // ── 公開：landing ──────────────────────────────────────────────
  app.get('/games/mgm/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const campaign = await mgmEngine.loadCampaignBySlug(slug);
      if (!campaign) return res.status(404).send('活動不存在');
      res.render('mgm_share', {
        title: campaign.name + ' — OpenRice LINE',
        campaign,
        liffId: defaultLiffId || '',
        addFriendUrl: process.env.LINE_OFFICIAL_ADD_FRIEND_URL || ''
      });
    } catch (err) {
      console.error('mgm landing error:', err && err.message);
      res.status(500).send('Server error');
    }
  });

  // ── 公開：我的進度 ─────────────────────────────────────────────
  app.get('/api/games/mgm/:slug/me', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const campaign = await mgmEngine.loadCampaignBySlug(slug);
      if (!campaign) return jsonErr(res, 404, 'not_found');
      const id = await verifyIdentity(String(req.query.line_user_id || '').trim(), String(req.query.id_token || '').trim());
      if (!id.pass) return jsonErr(res, id.reject.status, id.reject.code, { detail: id.reject.detail });
      const uid = id.uid;
      if (!uid) return jsonErr(res, 400, 'missing_line_user_id');

      const referrals = await mgmEngine.referralCount(campaign, uid);
      // 我在這檔活動已拿到的里數與轉盤機會
      const { rows: mine } = await query(
        `SELECT COALESCE(SUM((prize_snapshot->>'miles')::int), 0)::int AS miles,
                COALESCE(BOOL_OR(prize_snapshot->>'kind' = 'draw_ticket'), false) AS qualified
           FROM activity_plays WHERE activity_id = $1 AND line_user_id = $2`,
        [campaign.id, uid]
      );
      const nextMilesAt = campaign.perFriends > 0
        ? (Math.floor(referrals / campaign.perFriends) + 1) * campaign.perFriends
        : 0;
      const openForYou = mgmEngine.isTester(campaign, uid);
      res.json({
        ok: true,
        open: openForYou,
        campaign: {
          slug: campaign.slug, name: campaign.name, status: campaign.status,
          per_friends: campaign.perFriends, per_miles: campaign.perMiles,
          wheel_friends: campaign.wheelFriends,
          welcome_miles: campaign.welcomeMiles,
          share_title: campaign.shareTitle, share_text: campaign.shareText,
          share_image: campaign.shareImage
        },
        me: {
          referrals,
          miles: Number(mine[0].miles || 0),
          next_miles_at: nextMilesAt,
          next_miles_in: nextMilesAt > 0 ? Math.max(0, nextMilesAt - referrals) : 0,
          wheel_at: campaign.wheelFriends,
          wheel_in: Math.max(0, campaign.wheelFriends - referrals),
          draw_qualified: mine[0].qualified === true
        }
      });
    } catch (err) {
      console.error('mgm me error:', err && err.message);
      jsonErr(res, 500, 'me_failed');
    }
  });

  // ── 公開：邀請入帳 + 里程碑 ────────────────────────────────────
  app.post('/api/games/mgm/:slug/referral', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const inviteeId = String((req.body || {}).line_user_id || '').trim();
    const inviterId = String((req.body || {}).inviter_line_user_id || '').trim();
    const id = await verifyIdentity(inviteeId, String((req.body || {}).id_token || '').trim());
    if (!id.pass) {
      logAttempt(slug, inviterId, inviteeId, id.reject.code);
      return jsonErr(res, id.reject.status, id.reject.code, { detail: id.reject.detail });
    }
    try {
      const preCampaign = await mgmEngine.loadCampaignBySlug(slug);
      if (preCampaign && preCampaign.testUids && preCampaign.testUids.length > 0 &&
          (!mgmEngine.isTester(preCampaign, inviteeId) || !mgmEngine.isTester(preCampaign, inviterId))) {
        logAttempt(slug, inviterId, inviteeId, 'test_mode_blocked');
        return res.status(400).json({ ok: false, error: 'activity_not_active', detail: '活動還沒開始' });
      }
      const result = await registerReferral({ query, activitySlug: slug, gameType: 'mgm', inviterId, inviteeId });
      if (result.error) {
        logAttempt(slug, inviterId, inviteeId, result.error.code);
        return res.status(result.error.status).json({ ok: false, error: result.error.code, detail: result.error.detail });
      }
      logAttempt(slug, inviterId, inviteeId, result.counted ? 'counted' : 'duplicate');
      // 里程碑判定必須在回應前做完（serverless 回應後凍結）。
      // 既有好友點開不計獎（計數只算新朋友），跳過省兩次查詢
      if (result.counted && result.invitee_was_existing !== true) {
        try {
          const campaign = await mgmEngine.loadCampaignBySlug(slug);
          if (campaign) await mgmEngine.onReferralCounted(campaign, inviterId);
        } catch (e) { console.error('mgm milestone failed:', e.message); }
      }
      res.json(result);
    } catch (err) {
      console.error('mgm referral error:', err && err.message);
      logAttempt(slug, inviterId, inviteeId, 'server_error');
      jsonErr(res, 500, 'referral_failed', { detail: '系統忙線，等一下會自動再試。' });
    }
  });

  // ── 後台：頁面 ────────────────────────────────────────────────
  app.get('/admin/mgm', requireAdmin, (req, res) => {
    res.render('admin_mgm', {
      title: '揪友賺哩',
      bodyClass: 'admin-shell mgm-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ── 後台：資料 ────────────────────────────────────────────────
  // 報表吃「任何一檔活動」：帶 activity_id 就看那檔，沒帶就挑最近有人玩或有人邀請的那檔。
  async function resolveActivity(rawId) {
    const id = Number(rawId);
    if (Number.isFinite(id) && id > 0) {
      const { rows } = await query(
        `SELECT id, slug, name, game_type, status, start_at, end_at, rules,
                base_plays_per_user, referral_bonus_per, referral_invites_per_bonus, referral_bonus_max
           FROM activities WHERE id = $1`, [id]);
      if (rows[0]) return rows[0];
    }
    const { rows } = await query(
      `SELECT a.id, a.slug, a.name, a.game_type, a.status, a.start_at, a.end_at, a.rules,
              a.base_plays_per_user, a.referral_bonus_per, a.referral_invites_per_bonus, a.referral_bonus_max
         FROM activities a
        ORDER BY (EXISTS (SELECT 1 FROM activity_referrals r WHERE r.activity_id = a.id)) DESC,
                 (EXISTS (SELECT 1 FROM activity_plays p WHERE p.activity_id = a.id)) DESC,
                 a.id DESC
        LIMIT 1`);
    return rows[0] || null;
  }

  app.get('/admin/mgm/api/data', requireAdmin, async (req, res) => {
    try {
      const list = (await query(
        `SELECT a.id, a.slug, a.name, a.game_type, a.status,
                (SELECT COUNT(*) FROM activity_referrals r WHERE r.activity_id = a.id)::int AS referral_count,
                (SELECT COUNT(*) FROM activity_plays p WHERE p.activity_id = a.id)::int AS play_count
           FROM activities a ORDER BY a.id DESC`)).rows;
      const act = await resolveActivity(req.query.activity_id);
      if (!act) return res.json({ ok: true, activities: list, activity: null });
      const aid = act.id;

      const stats = (await query(
        `SELECT COALESCE(SUM((prize_snapshot->>'miles')::int), 0)::int AS miles_total,
                COALESCE(SUM((prize_snapshot->>'miles')::int)
                         FILTER (WHERE NOT COALESCE(is_redeemed, false)), 0)::int AS miles_pending,
                COUNT(*) FILTER (WHERE COALESCE(prize_snapshot->>'prize_type','') <> 'none')::int AS wins,
                COUNT(*)::int AS plays,
                COUNT(DISTINCT line_user_id)::int AS people
           FROM activity_plays WHERE activity_id = $1`, [aid])).rows[0];
      const refs = (await query(
        `SELECT COUNT(*) FILTER (WHERE invitee_was_existing IS FALSE)::int AS c,
                COUNT(*) FILTER (WHERE invitee_was_existing IS NOT FALSE)::int AS existing,
                COUNT(DISTINCT inviter_line_user_id)::int AS inviters
           FROM activity_referrals WHERE activity_id = $1`, [aid])).rows[0];

      const people = (await query(
        `SELECT p.line_user_id AS uid,
                COALESCE(u.line_display_name, MAX(p.line_display_name), '(沒有名字)') AS display_name,
                COUNT(*) FILTER (WHERE COALESCE(p.prize_snapshot->>'prize_type','') <> 'none')::int AS wins,
                COALESCE(SUM((p.prize_snapshot->>'miles')::int), 0)::int AS miles,
                COALESCE(SUM((p.prize_snapshot->>'miles')::int)
                         FILTER (WHERE NOT COALESCE(p.is_redeemed, false)), 0)::int AS miles_pending,
                COALESCE(SUM((p.prize_snapshot->>'miles')::int)
                         FILTER (WHERE COALESCE(p.is_redeemed, false)), 0)::int AS miles_done,
                MAX(p.played_at) AS last_at
           FROM activity_plays p
           LEFT JOIN users u ON u.line_user_id = p.line_user_id
          WHERE p.activity_id = $1
          GROUP BY p.line_user_id, u.line_display_name
          ORDER BY miles DESC, wins DESC, last_at DESC
          LIMIT 5000`, [aid])).rows;

      const ledger = (await query(
        `SELECT p.id, p.line_user_id, p.played_at,
                COALESCE(u.line_display_name, p.line_display_name, '(沒有名字)') AS display_name,
                COALESCE(p.prize_snapshot->>'name', '—') AS prize_name,
                COALESCE(p.prize_snapshot->>'prize_type', '') AS prize_type,
                (p.prize_snapshot->>'miles')::int AS miles,
                p.coupon_code,
                COALESCE(p.is_redeemed, false) AS granted_done
           FROM activity_plays p
           LEFT JOIN users u ON u.line_user_id = p.line_user_id
          WHERE p.activity_id = $1
          ORDER BY p.played_at DESC LIMIT 5000`, [aid])).rows;

      const inviters = (await query(
        `SELECT r.inviter_line_user_id AS uid,
                COALESCE(u.line_display_name, '(沒有名字)') AS display_name,
                COUNT(*) FILTER (WHERE r.invitee_was_existing IS FALSE)::int AS new_friends,
                COUNT(*) FILTER (WHERE r.invitee_was_existing IS NOT FALSE)::int AS existing_friends,
                MAX(r.created_at) AS last_at
           FROM activity_referrals r
           LEFT JOIN users u ON u.line_user_id = r.inviter_line_user_id
          WHERE r.activity_id = $1
          GROUP BY r.inviter_line_user_id, u.line_display_name
          ORDER BY new_friends DESC, last_at DESC LIMIT 2000`, [aid])).rows;

      const pairs = (await query(
        `SELECT r.created_at,
                r.inviter_line_user_id AS inviter_uid,
                COALESCE(ui.line_display_name, '(沒有名字)') AS inviter_name,
                r.invitee_line_user_id AS invitee_uid,
                COALESCE(uv.line_display_name, '(沒有名字)') AS invitee_name,
                COALESCE(r.invitee_was_existing, false) AS was_existing
           FROM activity_referrals r
           LEFT JOIN users ui ON ui.line_user_id = r.inviter_line_user_id
           LEFT JOIN users uv ON uv.line_user_id = r.invitee_line_user_id
          WHERE r.activity_id = $1
          ORDER BY r.created_at DESC LIMIT 5000`, [aid])).rows;

      res.json({
        ok: true,
        activities: list,
        activity: {
          id: act.id, slug: act.slug, name: act.name, game_type: act.game_type, status: act.status,
          start_at: act.start_at, end_at: act.end_at,
          base_plays_per_user: act.base_plays_per_user,
          referral_bonus_per: act.referral_bonus_per,
          referral_invites_per_bonus: act.referral_invites_per_bonus,
          referral_bonus_max: act.referral_bonus_max,
          stats: {
            referrals: refs.c, referrals_existing: refs.existing, inviters: refs.inviters,
            miles_total: stats.miles_total, miles_pending: stats.miles_pending,
            wins: stats.wins, plays: stats.plays, people: stats.people
          }
        },
        people, ledger, inviters, pairs, liffId: defaultLiffId || ''
      });
    } catch (err) {
      console.error('mgm admin data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', { detail: err && err.message });
    }
  });

  // ── 後台：建一檔新活動（draft + 預設獎品）──────────────────────
  app.post('/admin/mgm/api/create', requireOwner, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim() || '揪友賺哩';
      const slug = String(body.slug || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) return jsonErr(res, 400, 'bad_slug', { detail: '網址代號只能用小寫英數字與減號，3 到 40 字' });
      const rules = { mgm: {
        welcome_miles: 100, per_friends: 2, per_miles: 100,
        wheel_friends: 4, miles_cap: 0, repeat_ladder: false,
        share_title: name, share_text: '加入 OpenRice 官方帳號，一起拿「亞洲萬里通」里數', share_image: '', card_image: ''
      } };
      const ins = await query(
        `INSERT INTO activities (slug, name, description, game_type, status, rules,
                                 base_plays_per_user, referral_bonus_per, referral_bonus_max, require_follow_oa)
         VALUES ($1, $2, $3, 'mgm', 'draft', $4::jsonb, 1, 1, 0, true)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [slug, name, '揪友賺哩活動', JSON.stringify(rules)]
      );
      if (ins.rows.length === 0) return jsonErr(res, 409, 'slug_taken', { detail: '這個網址代號已經有活動在用了' });
      const aid = ins.rows[0].id;
      // 不建獎品：好友推薦沒有獎品池的概念，哩數由引擎直接寫進帳本。
      res.json({ ok: true, id: aid, slug });
    } catch (err) {
      console.error('mgm create error:', err && err.message);
      jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  // ── 後台：存設定 ──────────────────────────────────────────────
  app.post('/admin/mgm/api/config', requireOwner, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Math.floor(Number(body.id));
      if (!Number.isFinite(id) || id < 1) return jsonErr(res, 400, 'bad_id');
      const clamp = (v, min, max, d) => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
      };
      const mgm = {
        welcome_miles: clamp(body.welcome_miles, 0, 100000, 100),
        per_friends: clamp(body.per_friends, 1, 100, 2),
        per_miles: clamp(body.per_miles, 0, 100000, 100),
        wheel_friends: clamp(body.wheel_friends, 1, 100, 4),
        miles_cap: clamp(body.miles_cap, 0, 100000000, 0),
        repeat_ladder: !!body.repeat_ladder,
        share_title: String(body.share_title || '').trim().slice(0, 100),
        share_text: String(body.share_text || '').trim().slice(0, 300),
        share_image: String(body.share_image || '').trim().slice(0, 500),
        card_image: String(body.card_image || '').trim().slice(0, 500),
        welcome_image: String(body.welcome_image || '').trim().slice(0, 500),
        milestone_image: String(body.milestone_image || '').trim().slice(0, 500),
        wheel_image: String(body.wheel_image || '').trim().slice(0, 500),
        landing_image: String(body.landing_image || '').trim().slice(0, 500),
        test_uids: String(body.test_uids || '').split(/[\s,]+/)
          .map(x => x.trim()).filter(x => /^U[0-9a-f]{32}$/i.test(x)).slice(0, 50)
      };
      const status = ['draft', 'active', 'paused', 'ended'].includes(body.status) ? body.status : 'draft';
      const name = String(body.name || '').trim().slice(0, 100) || null;
      const upd = await query(
        `UPDATE activities SET
           rules = jsonb_set(COALESCE(rules, '{}'::jsonb), '{mgm}', $2::jsonb),
           status = $3,
           name = COALESCE($4, name),
           start_at = $5, end_at = $6,
           updated_at = now()
         WHERE id = $1 AND game_type = 'mgm'
         RETURNING id`,
        [id, JSON.stringify(mgm), status, name, body.start_at || null, body.end_at || null]
      );
      if (upd.rows.length === 0) return jsonErr(res, 404, 'not_found');
      // 這裡以前會自動補一列「里數獎品」到獎品池。已移除：
      // 好友推薦沒有獎品池的概念，哩數由引擎直接寫進帳本，補了只會讓「活動管理」多一頁看不懂的東西。
      res.json({ ok: true });
    } catch (err) {
      console.error('mgm config error:', err && err.message);
      jsonErr(res, 500, 'config_failed', { detail: err && err.message });
    }
  });

  // ── 後台：模擬一位新朋友點連結加入（一個人就能測完整條階梯）─────
  //   只在測試模式（test_uids 非空）可用：產生一個合成的被邀請人寫進
  //   activity_referrals（invitee_was_existing=false），再跑真實的里程碑
  //   引擎——2 位發 100 里卡、4 位發抽獎卡，推播都真的送到邀請人手機。
  //   合成資料用「重置測試資料」一鍵清掉。
  app.post('/admin/mgm/api/simulate-referral', requireOwner, async (req, res) => {
    try {
      const inviter = String((req.body || {}).inviter_line_user_id || '').trim();
      if (!/^U[0-9a-f]{32}$/i.test(inviter)) return jsonErr(res, 400, 'bad_uid', { detail: '邀請人 LINE ID 格式不對' });
      const { rows: camp } = await query(
        `SELECT id, slug, rules FROM activities WHERE game_type='mgm' ORDER BY id DESC LIMIT 1`);
      if (camp.length === 0) return jsonErr(res, 404, 'no_campaign');
      const campaign = await mgmEngine.loadCampaignBySlug(camp[0].slug);
      if (!campaign || !campaign.testUids || campaign.testUids.length === 0) {
        return jsonErr(res, 400, 'not_test_mode', { detail: '這顆按鈕只有測試模式（有測試名單）才能用，避免對正式資料灌假邀請' });
      }
      if (!mgmEngine.isTester(campaign, inviter)) {
        return jsonErr(res, 400, 'not_tester', { detail: '邀請人要在測試名單上' });
      }
      const crypto = require('crypto');
      const fakeInvitee = 'U' + crypto.randomBytes(16).toString('hex');
      await query(
        `INSERT INTO activity_referrals (activity_id, inviter_line_user_id, invitee_line_user_id, invitee_was_existing)
         VALUES ($1, $2, $3, false)`,
        [campaign.id, inviter, fakeInvitee]
      );
      logAttempt(campaign.slug, inviter, fakeInvitee, 'simulated');
      const milestones = await mgmEngine.onReferralCounted(campaign, inviter);
      const count = await mgmEngine.referralCount(campaign, inviter);
      res.json({ ok: true, referrals: count, milestones });
    } catch (err) {
      console.error('mgm simulate error:', err && err.message);
      jsonErr(res, 500, 'simulate_failed', { detail: err && err.message });
    }
  });

  // ── 後台：重置測試帳號（模擬三個角色用）──────────────────────
  //   清掉該帳號在這檔活動的：里數入帳、轉盤加碼、邀請紀錄（當邀請人與被邀請人）。
  //   make_new=true 再把 users 列標成封存 → 系統視他為「還不是會員」，
  //   點邀請連結會算新朋友、重新加好友會拿見面禮。只能用在測試帳號！
  app.post('/admin/mgm/api/reset-tester', requireOwner, async (req, res) => {
    try {
      const body = req.body || {};
      const uid = String(body.line_user_id || '').trim();
      if (!/^U[0-9a-f]{32}$/i.test(uid)) return jsonErr(res, 400, 'bad_uid', { detail: 'LINE ID 格式不對' });
      const { rows: camp } = await query(
        `SELECT id, slug FROM activities WHERE game_type='mgm' ORDER BY id DESC LIMIT 1`);
      if (camp.length === 0) return jsonErr(res, 404, 'no_campaign');
      const aid = camp[0].id, slug = camp[0].slug;
      const del1 = await query(
        `DELETE FROM activity_plays WHERE activity_id=$1 AND line_user_id=$2
         RETURNING COALESCE(prize_snapshot->>'kind','miles') AS kind`, [aid, uid]);
      const del2 = await query(`DELETE FROM activity_bonus_plays WHERE granted_key LIKE 'mgm:' || $1 || ':%:' || $2 RETURNING id`, [slug, uid]);
      const del3 = await query(`DELETE FROM activity_referrals WHERE activity_id=$1 AND (inviter_line_user_id=$2 OR invitee_line_user_id=$2) RETURNING id`, [aid, uid]);
      let madeNew = false;
      if (body.make_new === true) {
        const u = await query(`UPDATE users SET archived_at=now() WHERE line_user_id=$1 RETURNING id`, [uid]);
        madeNew = u.rows.length > 0;
      }
      const drawRows = del1.rows.filter(r => r.kind === 'draw_ticket').length;
      res.json({ ok: true, cleared: {
        miles_rows: del1.rows.length - drawRows,
        draw_tickets: drawRows + del2.rows.length,
        referrals: del3.rows.length
      }, made_new: madeNew });
    } catch (err) {
      console.error('mgm reset error:', err && err.message);
      jsonErr(res, 500, 'reset_failed', { detail: err && err.message });
    }
  });

  // ── 後台：大獎抽獎（只有你自己玩）──────────────────────────
  //    參加者 = 有抽獎資格的人。抽出來的結果寫進 activity_plays（kind=draw_win），
  //    不影響四張表；重抽要先把那一輪作廢，紀錄永遠留著。
  app.get('/admin/mgm/draw', requireAdmin, (req, res) => {
    res.render('admin_mgm_draw', {
      title: '大獎抽獎',
      bodyClass: 'admin-shell mgm-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/mgm/api/draw/data', requireAdmin, async (req, res) => {
    try {
      const act = await resolveActivity(req.query.activity_id);
      if (!act) return jsonErr(res, 404, 'no_activity');
      const pool = (await query(
        `SELECT x.uid,
                COALESCE(u.line_display_name, '(沒有名字)') AS display_name,
                x.joined_at
           FROM (
             SELECT p.line_user_id AS uid, MIN(p.played_at) AS joined_at
               FROM activity_plays p WHERE p.activity_id = $1 GROUP BY p.line_user_id
             UNION
             SELECT r.inviter_line_user_id AS uid, MIN(r.created_at) AS joined_at
               FROM activity_referrals r
              WHERE r.activity_id = $1 AND r.invitee_was_existing IS FALSE
              GROUP BY r.inviter_line_user_id
           ) x
           LEFT JOIN users u ON u.line_user_id = x.uid
          ORDER BY x.joined_at`, [act.id])).rows;
      const invited = (await query(
        `SELECT inviter_line_user_id AS uid,
                COUNT(*) FILTER (WHERE invitee_was_existing IS FALSE)::int AS new_friends
           FROM activity_referrals WHERE activity_id = $1
          GROUP BY inviter_line_user_id`, [act.id])).rows;
      const played = (await query(
        `SELECT line_user_id AS uid, COUNT(*)::int AS plays
           FROM activity_plays WHERE activity_id = $1 GROUP BY line_user_id`, [act.id])).rows;
      const winners = (await query(
        `SELECT p.id, p.line_user_id AS uid,
                COALESCE(u.line_display_name, '(沒有名字)') AS display_name,
                p.prize_snapshot->>'name' AS prize,
                p.prize_snapshot->>'round' AS round,
                COALESCE((p.prize_snapshot->>'voided')::boolean, false) AS voided,
                p.played_at AS won_at
           FROM activity_plays p
           LEFT JOIN users u ON u.line_user_id = p.line_user_id
          WHERE p.activity_id = $1 AND p.prize_snapshot->>'kind' = 'draw_win'
          ORDER BY p.played_at DESC`, [act.id])).rows;
      const activities = (await query(
        `SELECT id, slug, name, game_type, status FROM activities ORDER BY id DESC`)).rows;
      res.json({ ok: true, activities: activities,
        activity: { id: act.id, slug: act.slug, name: act.name, game_type: act.game_type },
        pool, invited, played, winners });
    } catch (err) {
      console.error('draw data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/mgm/api/draw', requireOwner, async (req, res) => {
    try {
      const body = req.body || {};
      const prize = String(body.prize || '').trim().slice(0, 60) || '大獎';
      const count = Math.max(1, Math.min(50, Number(body.count) || 1));
      const allowRepeat = body.allow_repeat === true;
      const minInvites = Math.max(0, Number(body.min_invites) || 0);
      const needPlayed = body.need_played === true;
      const act = await resolveActivity(body.activity_id);
      if (!act) return jsonErr(res, 404, 'no_activity');

      // 參加者：玩過或邀請成功過的人，再照條件篩（最少邀請幾位／一定要玩過）
      const { rows: pool } = await query(
        `WITH base AS (
           SELECT p.line_user_id AS uid FROM activity_plays p WHERE p.activity_id = $1
           UNION
           SELECT r.inviter_line_user_id FROM activity_referrals r
            WHERE r.activity_id = $1 AND r.invitee_was_existing IS FALSE
         )
         SELECT b.uid FROM base b
          WHERE (SELECT COUNT(*) FROM activity_referrals r2
                  WHERE r2.activity_id = $1 AND r2.inviter_line_user_id = b.uid
                    AND r2.invitee_was_existing IS FALSE) >= $3
            AND ($4::boolean = false OR EXISTS (
                  SELECT 1 FROM activity_plays p2
                   WHERE p2.activity_id = $1 AND p2.line_user_id = b.uid))
            AND ($2::boolean OR NOT EXISTS (
                  SELECT 1 FROM activity_plays w
                   WHERE w.activity_id = $1 AND w.line_user_id = b.uid
                     AND w.prize_snapshot->>'kind' = 'draw_win'
                     AND COALESCE((w.prize_snapshot->>'voided')::boolean, false) = false))`,
        [act.id, allowRepeat, minInvites, needPlayed]
      );
      if (pool.length === 0) return jsonErr(res, 400, 'empty_pool', { detail: '照這個條件沒有人可以抽' });
      if (pool.length < count) {
        return jsonErr(res, 400, 'not_enough', { detail: '只有 ' + pool.length + ' 個人符合條件，抽不出 ' + count + ' 位' });
      }

      const crypto = require('crypto');
      const uids = pool.map(r => r.uid);
      for (let i = uids.length - 1; i > 0; i--) {
        const j2 = crypto.randomInt(0, i + 1);
        const t = uids[i]; uids[i] = uids[j2]; uids[j2] = t;
      }
      const picked = uids.slice(0, count);
      const round = 'r' + Date.now().toString(36);

      const winners = [];
      for (let i = 0; i < picked.length; i++) {
        const uid = picked[i];
        const snapshot = { kind: 'draw_win', name: prize, prize_type: 'draw', round: round, seq: i + 1, voided: false };
        const mgmKey = 'draw:' + act.slug + ':' + round + ':' + uid;
        const ins = await query(
          `INSERT INTO activity_plays (activity_id, line_user_id, prize_snapshot, properties)
           SELECT $1, $2, $3::jsonb, $4::jsonb
           WHERE NOT EXISTS (SELECT 1 FROM activity_plays WHERE properties->>'mgm_key' = $5)
           RETURNING id, played_at`,
          [act.id, uid, JSON.stringify(snapshot),
           JSON.stringify({ mgm_key: mgmKey, kind: 'draw_win', round: round }), mgmKey]
        );
        if (ins.rows.length === 0) continue;
        const { rows: nm } = await query(
          `SELECT COALESCE(line_display_name, '(沒有名字)') AS n FROM users WHERE line_user_id = $1 LIMIT 1`, [uid]);
        winners.push({ id: ins.rows[0].id, uid: uid, display_name: (nm[0] && nm[0].n) || '(沒有名字)',
                       prize: prize, round: round, won_at: ins.rows[0].played_at });
      }
      res.json({ ok: true, round: round, prize: prize, winners: winners, pool_size: pool.length });
    } catch (err) {
      console.error('draw error:', err && err.message);
      jsonErr(res, 500, 'draw_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/mgm/api/draw/void', requireOwner, async (req, res) => {
    try {
      const round = String((req.body || {}).round || '').trim();
      if (!round) return jsonErr(res, 400, 'bad_round');
      const act = await resolveActivity((req.body || {}).activity_id);
      if (!act) return jsonErr(res, 404, 'no_activity');
      const upd = await query(
        `UPDATE activity_plays
            SET prize_snapshot = jsonb_set(prize_snapshot, '{voided}', 'true'::jsonb)
          WHERE activity_id = $1 AND prize_snapshot->>'kind' = 'draw_win'
            AND prize_snapshot->>'round' = $2
            AND COALESCE((prize_snapshot->>'voided')::boolean, false) = false
          RETURNING id`, [act.id, round]);
      res.json({ ok: true, voided: upd.rows.length });
    } catch (err) {
      console.error('draw void error:', err && err.message);
      jsonErr(res, 500, 'void_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/mgm/api/make-list', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const segment = String(body.segment || '').trim();
      const act = await resolveActivity(body.activity_id);
      if (!act) return jsonErr(res, 404, 'no_activity');
      const aid = act.id;

      const SQL = {
        pending_miles: `SELECT DISTINCT line_user_id FROM activity_plays
                         WHERE activity_id=$1 AND prize_snapshot->>'miles' IS NOT NULL
                           AND NOT COALESCE(is_redeemed,false)`,
        winners:       `SELECT DISTINCT line_user_id FROM activity_plays
                         WHERE activity_id=$1 AND COALESCE(prize_snapshot->>'prize_type','') <> 'none'`,
        players:       `SELECT DISTINCT line_user_id FROM activity_plays WHERE activity_id=$1`,
        inviters:      `SELECT DISTINCT inviter_line_user_id AS line_user_id FROM activity_referrals
                         WHERE activity_id=$1 AND invitee_was_existing IS FALSE`
      };
      if (!SQL[segment]) return jsonErr(res, 400, 'bad_segment', { detail: '名單類型不對' });

      const uids = (await query(SQL[segment], [aid])).rows
        .map(r => String(r.line_user_id || '').trim())
        .filter(u => /^U[0-9a-f]{32}$/i.test(u));
      if (uids.length === 0) return jsonErr(res, 400, 'empty', { detail: '這個條件目前沒有人，沒有建立名單' });

      const LABEL = { pending_miles: '哩數待發放', winners: '中過獎', players: '玩過的人', inviters: '邀請成功' };
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const name = String(body.name || '').trim() ||
        (act.name + '－' + LABEL[segment] + '（' + stamp + '）');
      const createdBy = (req.authUser && req.authUser.un) || 'admin';

      const ins = await query(
        `INSERT INTO admin_recipient_lists (name, description, total, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, name, total`,
        [name.slice(0, 120), '從活動報表建立：' + act.name + ' / ' + LABEL[segment], uids.length, createdBy]
      );
      const listId = ins.rows[0].id;
      try {
        const BATCH = 500;
        for (let i2 = 0; i2 < uids.length; i2 += BATCH) {
          const slice = uids.slice(i2, i2 + BATCH);
          const values = [], params = [];
          slice.forEach((uid, idx) => {
            values.push('($' + (idx * 2 + 1) + ', $' + (idx * 2 + 2) + ')');
            params.push(listId, uid);
          });
          await query(
            `INSERT INTO admin_recipient_list_members (list_id, line_user_id) VALUES ` + values.join(', '),
            params
          );
        }
      } catch (e) {
        await query(`DELETE FROM admin_recipient_lists WHERE id=$1`, [listId]).catch(() => {});
        throw e;
      }
      res.json({ ok: true, list: { id: listId, name: ins.rows[0].name, total: uids.length } });
    } catch (err) {
      console.error('make-list error:', err && err.message);
      jsonErr(res, 500, 'make_list_failed', { detail: err && err.message });
    }
  });

  // ── 後台：批次標記已發放（人工入帳完成）───────────────────────
  app.post('/admin/mgm/api/mark-granted', requireAdmin, async (req, res) => {
    try {
      const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : [])
        .map(x => Math.floor(Number(x))).filter(x => Number.isFinite(x) && x > 0).slice(0, 5000);
      if (ids.length === 0) return jsonErr(res, 400, 'no_ids', { detail: '先勾選要標記的名單' });
      const upd = await query(
        `UPDATE activity_plays SET is_redeemed = true, redeemed_at = now()
          WHERE id = ANY($1::bigint[])
            AND prize_snapshot->>'miles' IS NOT NULL
            AND COALESCE(is_redeemed, false) = false
          RETURNING id`,
        [ids]
      );
      res.json({ ok: true, marked: upd.rows.length });
    } catch (err) {
      console.error('mgm mark error:', err && err.message);
      jsonErr(res, 500, 'mark_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerMgmMilesRoutes };
