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
      const baseWhere = `line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false`;
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
      // 「玩過幾次」排除後台大獎抽獎寫進來的 kind='draw_win'（那不是他自己抽的）。
      const c1 = await query(`SELECT COUNT(*) FILTER (WHERE COALESCE(prize_snapshot->>'kind', '') <> 'draw_win')::int AS plays,
                                     COUNT(*) FILTER (WHERE prize_id IS NOT NULL)::int AS wins
                                FROM activity_plays WHERE line_user_id = $1`, [luid]);
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

      return res.json({ ok: true, profile, counts, interest, preference, lists, timeline, rfm, liff, booking_source: bookingSource });
    } catch (err) {
      return jsonErr(res, 500, 'profile_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminUsersRoutes };
