/**
 * 用戶 360 檔案（Customer Profile）— 把單一用戶在系統內的所有行為集中看
 *
 *   GET  /admin/users                         頁面（搜尋 + 列表 + 檔案）
 *   GET  /admin/users/api/list?search=&offset= 用戶列表
 *   GET  /admin/users/api/profile/:lineUserId  單一用戶：基本資料 + 行為統計 + 餐廳興趣 + 活動頁行為 + 訂位來源 + 時間軸
 */

const { LIFECYCLE_STAGE_SQL, LAST_ACTIVITY_SQL, LIFF_EVENTS_SOURCE } = require('../core/broadcastAudience');

// 訂位來源資料來源：已經整理成「每人最新一筆」的檢視，不要自己去接原始回答表。
const BOOKING_SOURCE_SOURCE = 'member_booking_source';

// 活動頁行為一次最多統計幾筆（避免單一重度使用者把查詢拖慢）
const LIFF_SCAN_LIMIT = 5000;
// 面板上「最近做了什麼」列幾筆
const LIFF_RECENT_LIMIT = 10;
// 「最近看過的餐廳」最多列幾間，以及往回翻幾筆行為來湊出這幾間
const LIFF_RESTAURANT_LIMIT = 5;
const LIFF_RESTAURANT_SCAN = 300;

function registerAdminUsersRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  app.get('/admin/users', requireAdmin, (req, res) => {
    res.render('admin_users', {
      title: '用戶檔案',
      bodyClass: 'admin-shell users-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表（含搜尋）
  app.get('/admin/users/api/list', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const searchRaw = String(req.query.search || '').trim().toLowerCase();
      const search = searchRaw.replace(/[\\%_]/g, '\\$&'); // 跳脫 LIKE 萬用字元
      // 搜尋條件：$1 = like pattern（有搜尋才用）
      const tagId = Number(req.query.tag_id) || null;
      const baseWhere = `line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false` +
        (tagId ? ` AND line_user_id IN (SELECT line_user_id FROM user_tag_members WHERE tag_id = ${tagId})` : '');
      const searchWhere = searchRaw
        ? ` AND (LOWER(line_user_id) LIKE $1 ESCAPE '\\' OR LOWER(COALESCE(line_display_name,'')) LIKE $1 ESCAPE '\\' OR LOWER(COALESCE(username,'')) LIKE $1 ESCAPE '\\')`
        : '';
      const likeParam = searchRaw ? ['%' + search + '%'] : [];
      const listParams = likeParam.concat([limit, offset]);
      const rs = await query(
        `SELECT id, line_user_id, line_display_name, username, created_at, blocked_at, archived_at
         FROM users WHERE ${baseWhere}${searchWhere}
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT $${likeParam.length + 1} OFFSET $${likeParam.length + 2}`,
        listParams
      );
      const cnt = await query(`SELECT COUNT(*)::int AS n FROM users WHERE ${baseWhere}${searchWhere}`, likeParam);
      return res.json({ ok: true, users: rs.rows, total: Number(cnt.rows[0]?.n || 0) });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // 單一用戶 360
  // ── 用戶標籤 ─────────────────────────────────────────────
  app.get('/admin/users/api/tags', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT t.id, t.name, t.color,
                (SELECT COUNT(*)::int FROM user_tag_members m WHERE m.tag_id = t.id) AS members
           FROM user_tags t ORDER BY t.name`);
      res.json({ ok: true, tags: rows });
    } catch (err) { jsonErr(res, 500, 'tags_failed', { detail: err && err.message }); }
  });

  app.post('/admin/users/api/tags', requireAdmin, async (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim().slice(0, 30);
      const color = /^#[0-9a-fA-F]{6}$/.test(String((req.body || {}).color || '')) ? req.body.color : '#FBC02D';
      if (!name) return jsonErr(res, 400, 'name_required', { detail: '標籤要有名字' });
      const by = (req.authUser && req.authUser.un) || 'admin';
      const ins = await query(
        `INSERT INTO user_tags (name, color, created_by) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
         RETURNING id, name, color`,
        [name, color, by]);
      res.json({ ok: true, tag: ins.rows[0] });
    } catch (err) { jsonErr(res, 500, 'tag_create_failed', { detail: err && err.message }); }
  });

  app.post('/admin/users/api/tags/delete', requireAdmin, async (req, res) => {
    try {
      const id = Number((req.body || {}).id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      await query(`DELETE FROM user_tags WHERE id = $1`, [id]);  // members 連動刪除
      res.json({ ok: true });
    } catch (err) { jsonErr(res, 500, 'tag_delete_failed', { detail: err && err.message }); }
  });

  // ── 自動貼標籤規則 ────────────────────────────────────────
  // 規則＝「做過某件事滿 N 次 → 自動貼某標籤」。只會貼、不會自動撕（要撕手動）。
  const RULE_SQL = {
    won_prize: `SELECT line_user_id AS uid FROM activity_plays
                 WHERE COALESCE(prize_snapshot->>'prize_type','') <> 'none'
                   AND COALESCE(prize_snapshot->>'kind','') <> 'draw_win'
                   AND line_user_id IS NOT NULL
                 GROUP BY line_user_id HAVING COUNT(*) >= $2`,
    played:    `SELECT line_user_id AS uid FROM activity_plays
                 WHERE COALESCE(prize_snapshot->>'kind','') <> 'draw_win' AND line_user_id IS NOT NULL
                 GROUP BY line_user_id HAVING COUNT(*) >= $2`,
    invited:   `SELECT inviter_line_user_id AS uid FROM activity_referrals
                 WHERE invitee_was_existing IS FALSE
                 GROUP BY inviter_line_user_id HAVING COUNT(*) >= $2`,
    was_invited:`SELECT invitee_line_user_id AS uid FROM activity_referrals
                 GROUP BY invitee_line_user_id HAVING COUNT(*) >= $2`,
    menu_tap:  `SELECT line_user_id AS uid FROM rich_menu_taps
                 WHERE line_user_id IS NOT NULL
                 GROUP BY line_user_id HAVING COUNT(*) >= $2`,
    messaged:  `SELECT line_user_id AS uid FROM line_webhook_events
                 WHERE event_type = 'message' AND line_user_id IS NOT NULL
                 GROUP BY line_user_id HAVING COUNT(*) >= $2`
  };

  async function runTagRules() {
    const { rows: rules } = await query(
      `SELECT r.id, r.tag_id, r.rule_kind, r.threshold, t.name AS tag_name
         FROM user_tag_rules r JOIN user_tags t ON t.id = r.tag_id
        WHERE r.active = true ORDER BY r.id`);
    const results = [];
    for (const r of rules) {
      const src = RULE_SQL[r.rule_kind];
      if (!src) continue;
      try {
        const ins = await query(
          `INSERT INTO user_tag_members (tag_id, line_user_id, added_by)
           SELECT $1, x.uid, '自動規則' FROM (` + src + `) x
           ON CONFLICT DO NOTHING RETURNING line_user_id`,
          [r.tag_id, Math.max(1, Number(r.threshold) || 1)]);
        await query(`UPDATE user_tag_rules SET last_run_at = now(), last_added = $2 WHERE id = $1`,
          [r.id, ins.rows.length]);
        results.push({ id: r.id, tag: r.tag_name, added: ins.rows.length });
      } catch (e) {
        console.error('tag rule failed:', r.id, e.message);
        results.push({ id: r.id, tag: r.tag_name, error: true });
      }
    }
    return results;
  }

  app.get('/admin/users/api/tag-rules', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.tag_id, r.rule_kind, r.threshold, r.active, r.last_run_at, r.last_added,
                t.name AS tag_name, t.color AS tag_color
           FROM user_tag_rules r JOIN user_tags t ON t.id = r.tag_id ORDER BY r.id`);
      res.json({ ok: true, rules: rows });
    } catch (err) { jsonErr(res, 500, 'rules_failed', { detail: err && err.message }); }
  });

  app.post('/admin/users/api/tag-rules', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const tagId = Number(body.tag_id);
      const kind = String(body.rule_kind || '');
      const threshold = Math.max(1, Math.min(1000, Number(body.threshold) || 1));
      if (!tagId || !RULE_SQL[kind]) return jsonErr(res, 400, 'bad_rule', { detail: '規則沒選齊' });
      const by = (req.authUser && req.authUser.un) || 'admin';
      const ins = await query(
        `INSERT INTO user_tag_rules (tag_id, rule_kind, threshold, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tagId, kind, threshold, by]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (err) { jsonErr(res, 500, 'rule_create_failed', { detail: err && err.message }); }
  });

  app.post('/admin/users/api/tag-rules/delete', requireAdmin, async (req, res) => {
    try {
      const id = Number((req.body || {}).id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      await query(`DELETE FROM user_tag_rules WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { jsonErr(res, 500, 'rule_delete_failed', { detail: err && err.message }); }
  });

  app.post('/admin/users/api/tag-rules/toggle', requireAdmin, async (req, res) => {
    try {
      const id = Number((req.body || {}).id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const upd = await query(
        `UPDATE user_tag_rules SET active = NOT active WHERE id = $1 RETURNING active`, [id]);
      if (!upd.rows.length) return jsonErr(res, 404, 'not_found');
      res.json({ ok: true, active: upd.rows[0].active });
    } catch (err) { jsonErr(res, 500, 'rule_toggle_failed', { detail: err && err.message }); }
  });

  // 手動立即執行（後台按鈕）
  app.post('/admin/users/api/tag-rules/run', requireAdmin, async (_req, res) => {
    try { res.json({ ok: true, results: await runTagRules() }); }
    catch (err) { jsonErr(res, 500, 'run_failed', { detail: err && err.message }); }
  });

  // 排程執行（每 5 分鐘，跟其他排程共用 secret）
  app.post('/admin/users/run-tag-rules', async (req, res) => {
    try {
      const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
      if (!secret || req.get('X-Scheduler-Secret') !== secret) return jsonErr(res, 403, 'forbidden');
      res.json({ ok: true, results: await runTagRules() });
    } catch (err) { jsonErr(res, 500, 'run_failed', { detail: err && err.message }); }
  });

  // 幫單一用戶貼／撕標籤
  app.post('/admin/users/api/tag', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const luid = String(body.line_user_id || '').trim();
      const tagId = Number(body.tag_id);
      if (!/^U[0-9a-f]{32}$/i.test(luid) || !tagId) return jsonErr(res, 400, 'bad_id');
      const by = (req.authUser && req.authUser.un) || 'admin';
      if (body.on === false) {
        await query(`DELETE FROM user_tag_members WHERE tag_id = $1 AND line_user_id = $2`, [tagId, luid]);
      } else {
        await query(
          `INSERT INTO user_tag_members (tag_id, line_user_id, added_by) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [tagId, luid, by]);
      }
      res.json({ ok: true });
    } catch (err) { jsonErr(res, 500, 'tag_failed', { detail: err && err.message }); }
  });

  // 把標籤成員存成名單（接群發／圖文選單名單專屬）
  app.post('/admin/users/api/tags/to-list', requireAdmin, async (req, res) => {
    try {
      const tagId = Number((req.body || {}).tag_id);
      if (!tagId) return jsonErr(res, 400, 'bad_id');
      const { rows: t } = await query(`SELECT name FROM user_tags WHERE id = $1`, [tagId]);
      if (!t.length) return jsonErr(res, 404, 'not_found');
      const { rows: ms } = await query(
        `SELECT line_user_id FROM user_tag_members WHERE tag_id = $1 LIMIT 20000`, [tagId]);
      const uids = ms.map(x => String(x.line_user_id || '').trim()).filter(u => /^U[0-9a-f]{32}$/i.test(u));
      if (!uids.length) return jsonErr(res, 400, 'empty', { detail: '這個標籤還沒有人' });
      const by = (req.authUser && req.authUser.un) || 'admin';
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const ins = await query(
        `INSERT INTO admin_recipient_lists (name, description, total, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, name, total`,
        [('標籤：' + t[0].name + '（' + stamp + '）').slice(0, 120), '從用戶標籤建立', uids.length, by]);
      const listId = ins.rows[0].id;
      try {
        for (let i = 0; i < uids.length; i += 500) {
          const slice = uids.slice(i, i + 500);
          const values = [], params = [];
          slice.forEach((uid, idx) => { values.push('($' + (idx * 2 + 1) + ', $' + (idx * 2 + 2) + ')'); params.push(listId, uid); });
          await query(`INSERT INTO admin_recipient_list_members (list_id, line_user_id) VALUES ` + values.join(', '), params);
        }
      } catch (e) {
        await query(`DELETE FROM admin_recipient_lists WHERE id=$1`, [listId]).catch(() => {});
        throw e;
      }
      res.json({ ok: true, list: ins.rows[0] });
    } catch (err) { jsonErr(res, 500, 'to_list_failed', { detail: err && err.message }); }
  });

  app.get('/admin/users/api/profile/:lineUserId', requireAdmin, async (req, res) => {
    const luid = String(req.params.lineUserId || '').trim();
    if (!/^U[0-9a-f]{32}$/i.test(luid)) return jsonErr(res, 400, 'invalid_line_user_id');
    try {
      const uRs = await query(
        `SELECT u.id, u.line_user_id, u.line_display_name, u.line_picture_url, u.username,
                u.created_at, u.blocked_at, u.invite_code, u.draws_left, u.extra_draws,
                ${LIFECYCLE_STAGE_SQL} AS lifecycle_stage,
                FLOOR(EXTRACT(EPOCH FROM (now() - ${LAST_ACTIVITY_SQL})) / 86400)::int AS days_since_active
         FROM users u WHERE u.line_user_id = $1`,
        [luid]
      );
      const profile = uRs.rows[0] || { line_user_id: luid };
      const userId = profile.id || null;

      // RFM 增益：OA users 表沒有 email，故僅以 lineId 配對外部 RFM 檔案
      const rfmRs = await query(
        `SELECT rfm_user_id, recency, frequency, monetary_est, email, phone, updated_at, true AS matched_by_line
         FROM rfm_profiles WHERE line_user_id = $1 LIMIT 1`,
        [luid]
      );
      const rfm = rfmRs.rows[0] || null;

      // 行為統計
      const counts = {};
      const c1 = await query(`SELECT COUNT(*)::int AS plays, COUNT(*) FILTER (WHERE prize_id IS NOT NULL)::int AS wins FROM activity_plays WHERE line_user_id = $1`, [luid]);
      counts.game_plays = Number(c1.rows[0]?.plays || 0);
      counts.prizes_won = Number(c1.rows[0]?.wins || 0);
      counts.broadcast_clicks = Number((await query(`SELECT COUNT(*)::int AS n FROM admin_broadcast_clicks WHERE line_user_id = $1`, [luid])).rows[0]?.n || 0);
      counts.restaurant_clicks = Number((await query(`SELECT COUNT(*)::int AS n FROM user_restaurant_clicks WHERE line_user_id = $1`, [luid])).rows[0]?.n || 0);
      counts.inbound_messages = Number((await query(`SELECT COUNT(*)::int AS n FROM line_webhook_events WHERE line_user_id = $1 AND event_type = 'message'`, [luid])).rows[0]?.n || 0);
      counts.invites_rewarded = userId
        ? Number((await query(`SELECT COUNT(*)::int AS n FROM line_invites WHERE inviter_user_id = $1 AND status = 'rewarded'`, [userId])).rows[0]?.n || 0)
        : 0;
      // LIFF 追蹤 07-17 起把 line_id 換成雜湊值，明碼只查得到舊資料 → 雙軌比對
      const hashRow = (await query(`SELECT line_id_hash FROM users WHERE line_user_id = $1 LIMIT 1`, [luid])).rows[0];
      const luidHash = (hashRow && hashRow.line_id_hash) || 'no-hash';
      counts.liff_events = Number((await query(
        `SELECT COUNT(*)::int AS n FROM user_events WHERE line_id = $1 OR line_id = $2`,
        [luid, luidHash])).rows[0]?.n || 0);

      // 餐廳興趣（點過的餐廳 Top，LEFT JOIN 目錄帶出種類/價位）
      const interest = (await query(
        `SELECT COALESCE(c.restaurant_query, c.poi_id) AS name, COUNT(*)::int AS clicks, MAX(c.clicked_at) AS last,
                rc.cuisine, rc.price_band
         FROM user_restaurant_clicks c
         LEFT JOIN restaurant_catalog rc ON COALESCE(c.poi_id, lower(btrim(c.restaurant_query))) = rc.ref_key
         WHERE c.line_user_id = $1 AND (c.restaurant_query IS NOT NULL OR c.poi_id IS NOT NULL)
         GROUP BY COALESCE(c.restaurant_query, c.poi_id), rc.cuisine, rc.price_band
         ORDER BY clicks DESC, last DESC LIMIT 10`,
        [luid]
      )).rows;

      // 口味偏好彙總（只計有標記種類/價位的餐廳點擊）
      const prefCuisine = (await query(
        `SELECT rc.cuisine AS k, COUNT(*)::int AS n
         FROM user_restaurant_clicks c
         JOIN restaurant_catalog rc ON COALESCE(c.poi_id, lower(btrim(c.restaurant_query))) = rc.ref_key
         WHERE c.line_user_id = $1 AND rc.cuisine IS NOT NULL
         GROUP BY rc.cuisine ORDER BY n DESC`,
        [luid]
      )).rows;
      const prefPrice = (await query(
        `SELECT rc.price_band AS k, COUNT(*)::int AS n
         FROM user_restaurant_clicks c
         JOIN restaurant_catalog rc ON COALESCE(c.poi_id, lower(btrim(c.restaurant_query))) = rc.ref_key
         WHERE c.line_user_id = $1 AND rc.price_band IS NOT NULL
         GROUP BY rc.price_band ORDER BY n DESC`,
        [luid]
      )).rows;
      const preference = { cuisine: prefCuisine, price_band: prefPrice };

      // 標籤
      const tags = (await query(
        `SELECT t.id, t.name, t.color FROM user_tag_members m
         JOIN user_tags t ON t.id = m.tag_id
         WHERE m.line_user_id = $1 ORDER BY t.name`,
        [luid]
      )).rows;

      // 行為記錄（統一時間軸）：加好友/封鎖、玩遊戲與中獎、邀請、按選單——各表湊起來新到舊
      const actions = (await query(
        `SELECT * FROM (
           SELECT '加入好友' AS kind, NULL::text AS detail, created_at AS at FROM users WHERE line_user_id = $1
           UNION ALL
           SELECT '封鎖官方帳號', NULL, blocked_at FROM users WHERE line_user_id = $1 AND blocked_at IS NOT NULL
           UNION ALL
           SELECT CASE WHEN COALESCE(p.prize_snapshot->>'prize_type','') = 'none' THEN '玩遊戲（沒中）'
                       WHEN COALESCE(p.prize_snapshot->>'kind','') = 'draw_win' THEN '被抽中大獎'
                       ELSE '玩遊戲中獎' END,
                  COALESCE(a.name,'') || CASE WHEN COALESCE(p.prize_snapshot->>'prize_type','') = 'none' THEN ''
                       ELSE ('：' || COALESCE(p.prize_snapshot->>'name','')) END,
                  p.played_at
             FROM activity_plays p LEFT JOIN activities a ON a.id = p.activity_id
            WHERE p.line_user_id = $1
           UNION ALL
           SELECT '邀請朋友成功',
                  COALESCE(u2.line_display_name, r.invitee_line_user_id) ||
                  CASE WHEN r.invitee_was_existing IS FALSE THEN '' ELSE '（本來就是好友，不計獎）' END,
                  r.created_at
             FROM activity_referrals r LEFT JOIN users u2 ON u2.line_user_id = r.invitee_line_user_id
            WHERE r.inviter_line_user_id = $1
           UNION ALL
           SELECT '被朋友邀請進來', COALESCE(u3.line_display_name, r2.inviter_line_user_id), r2.created_at
             FROM activity_referrals r2 LEFT JOIN users u3 ON u3.line_user_id = r2.inviter_line_user_id
            WHERE r2.invitee_line_user_id = $1
           UNION ALL
           SELECT CASE WHEN t.kind = 'tab' THEN '切換選單分頁' ELSE '按圖文選單' END,
                  COALESCE(t.label, ''), t.created_at
             FROM rich_menu_taps t WHERE t.line_user_id = $1
         ) x WHERE at IS NOT NULL
         ORDER BY at DESC LIMIT 50`,
        [luid]
      )).rows;

      // 名單歸屬（在哪些名單裡）
      const lists = (await query(
        `SELECT rl.id, rl.name FROM admin_recipient_list_members m
         JOIN admin_recipient_lists rl ON rl.id = m.list_id
         WHERE m.line_user_id = $1 ORDER BY rl.id DESC`,
        [luid]
      )).rows;

      // 活動頁行為（好康地圖／擲骰子選餐廳）
      // 用已經把行為對應到會員的檢視，不要自己去接原始行為表。
      // 檢視若還沒建好或查詢失敗，就當作沒有資料，不要害整份檔案打不開。
      // 活動頁在 07-08 改版換過一批行為代號，統計一律新舊都算，
      // 否則改版後才來的會員會全部顯示 0。
      //   幫我決定：新 map_decide_click / map_decide_result，舊 submit_draw / result_shown
      //   重抽    ：新 map_decide_redraw，舊 redraw
      //   點餐廳  ：地圖上三種圖釘 + 清單裡點的都算，舊 restaurant_click
      // 「幫我決定」取按鈕與結果兩邊的較大值，避免同一次決定被算成兩次。
      let liff = null;
      try {
        const liffAgg = (await query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE event_name = 'app_open')::int AS opens,
                  COUNT(*) FILTER (WHERE event_name IN ('map_pin_click','map_ext_pin_click','map_star_pin_click','map_sheet_item_click','restaurant_click'))::int AS restaurant_clicks,
                  COUNT(*) FILTER (WHERE event_name = 'map_booking_click')::int AS booking_clicks,
                  GREATEST(
                    COUNT(*) FILTER (WHERE event_name IN ('map_decide_click','submit_draw')),
                    COUNT(*) FILTER (WHERE event_name IN ('map_decide_result','result_shown'))
                  )::int AS draws,
                  COUNT(*) FILTER (WHERE event_name IN ('map_decide_redraw','redraw'))::int AS redraws,
                  MAX(created_at) AS last_at
           FROM (
             SELECT event_name, created_at FROM ${LIFF_EVENTS_SOURCE}
             WHERE line_user_id = $1
             ORDER BY created_at DESC LIMIT ${LIFF_SCAN_LIMIT}
           ) e`,
          [luid]
        )).rows[0] || {};
        const liffRecent = (await query(
          `SELECT event_name, created_at FROM ${LIFF_EVENTS_SOURCE}
           WHERE line_user_id = $1
           ORDER BY created_at DESC LIMIT ${LIFF_RECENT_LIMIT}`,
          [luid]
        )).rows;
        // 最近對哪幾間餐廳有興趣：從最近幾筆行為裡把餐廳名挑出來去重，
        // 其中有按過訂位的另外標記，後台一眼看得出誰快要成交。
        const liffRestaurants = (await query(
          `SELECT name, MAX(at) AS last_at, BOOL_OR(booked) AS booked FROM (
             SELECT NULLIF(BTRIM(properties->>'name'), '') AS name,
                    created_at AS at,
                    (event_name = 'map_booking_click') AS booked
             FROM ${LIFF_EVENTS_SOURCE}
             WHERE line_user_id = $1
               AND event_name IN ('map_pin_click','map_restaurant_view','map_sheet_item_click','map_booking_click')
             ORDER BY created_at DESC LIMIT ${LIFF_RESTAURANT_SCAN}
           ) r
           WHERE name IS NOT NULL
           GROUP BY name
           ORDER BY last_at DESC
           LIMIT ${LIFF_RESTAURANT_LIMIT}`,
          [luid]
        )).rows;
        liff = {
          total: Number(liffAgg.total || 0),
          opens: Number(liffAgg.opens || 0),
          restaurant_clicks: Number(liffAgg.restaurant_clicks || 0),
          booking_clicks: Number(liffAgg.booking_clicks || 0),
          draws: Number(liffAgg.draws || 0),
          redraws: Number(liffAgg.redraws || 0),
          last_at: liffAgg.last_at || null,
          capped: Number(liffAgg.total || 0) >= LIFF_SCAN_LIMIT,
          recent: liffRecent,
          restaurants: liffRestaurants
        };
      } catch (err) {
        console.error('user profile liff error:', err && err.message);
        liff = null;
      }

      // 訂位來源：這位會員在 LINE 上回答過「透過哪裡訂位」的最新一筆。
      // 沒回答過就是 null，前端直接不顯示這一項。
      let bookingSource = null;
      try {
        const bsRow = (await query(
          `SELECT source_key, source_label, answered_at
           FROM ${BOOKING_SOURCE_SOURCE} WHERE line_user_id = $1 LIMIT 1`,
          [luid]
        )).rows[0];
        if (bsRow && String(bsRow.source_label || '').trim()) {
          bookingSource = {
            key: bsRow.source_key || null,
            label: String(bsRow.source_label).trim(),
            answered_at: bsRow.answered_at || null
          };
        }
      } catch (err) {
        console.error('user profile booking source error:', err && err.message);
        bookingSource = null;
      }

      // 時間軸（多來源 union）
      const tlParams = userId ? [luid, userId, luidHash] : [luid, -1, luidHash];
      const timeline = (await query(
        `SELECT kind, label, at FROM (
           SELECT event_type AS kind, COALESCE(detail, event_type) AS label, event_timestamp AS at
             FROM line_webhook_events WHERE line_user_id = $1 AND event_type IN ('follow','unfollow','message')
           UNION ALL
           SELECT 'game_play', COALESCE(prize_snapshot->>'name','遊玩活動'), played_at FROM activity_plays WHERE line_user_id = $1
           UNION ALL
           SELECT 'restaurant_click', COALESCE(restaurant_query, poi_id, '餐廳'), clicked_at FROM user_restaurant_clicks WHERE line_user_id = $1
           UNION ALL
           SELECT 'broadcast_click', LEFT(target_url, 80), clicked_at FROM admin_broadcast_clicks WHERE line_user_id = $1
           UNION ALL
           SELECT 'liff', event_name, created_at FROM user_events WHERE line_id = $1 OR line_id = $3
           UNION ALL
           SELECT 'invite_rewarded', invitee_line_user_id, rewarded_at FROM line_invites WHERE inviter_user_id = $2 AND status = 'rewarded'
         ) t WHERE at IS NOT NULL ORDER BY at DESC LIMIT 40`,
        tlParams
      )).rows;

      return res.json({ ok: true, profile, counts, interest, preference, lists, tags, actions, timeline, rfm, liff, booking_source: bookingSource });
    } catch (err) {
      return jsonErr(res, 500, 'profile_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminUsersRoutes };
