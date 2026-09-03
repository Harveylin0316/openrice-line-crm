/**
 * LIFF 數據分析後台路由 — 好康地圖（今天吃什麼 / Random Rice）
 *
 * 目前只接這一個 LIFF。未來新增其他 LIFF 時，可在同一個 menu 下增加子路徑
 * （e.g. /admin/liff/xxx），共用 user_events 表、透過 properties 區分來源即可。
 *
 * 資料源：CRM 同個 Supabase 的 user_events 表。
 *
 * ------------------------------------------------------------------
 * 【2026-07 口徑重整】對外的活動頁改版過，行為紀錄的名稱整批換新，
 * 舊名稱只剩歷史資料（submit_draw / result_shown 停在 07-08；
 * redraw / restaurant_click / ad_shown 停在 06-18）。
 * 這頁原本整頁建在那些舊名稱上，所以近期數字幾乎全是 0。
 *
 * 現在改吃現行名稱，並在同類統計用 IN (新, 舊) 一起算，
 * 讓拉長區間看的時候，線不會在改版那天憑空斷掉。
 *
 * 現在的口徑（畫面文案一律講白話，下面這些代號只留在程式碼裡）：
 *   開啟活動頁 = app_open
 *   打開地圖   = map_open
 *   看餐廳     = 點圖釘 / 點清單裡的餐廳 / 看餐廳詳情，這幾種都算（含舊的 restaurant_click）
 *   點訂位     = map_booking_click ← 真正的商業轉換終點，漏斗最後一步就是它
 *   幫我決定   = map_decide_click；出結果 = map_decide_result；重抽 = map_decide_redraw
 *
 * 為什麼每個數字都給「來訪 / 人 / 次數」三種算法：
 * 很多人不是從 LINE 裡面打開活動頁，那筆紀錄就沒帶身分（近 30 天 app_open
 * 有三分之一以上算不出是誰），只看「人」會忽高忽低甚至上下步倒過來；
 * 「來訪」每一次都一定有，拿來看漏斗最穩，所以畫面預設用它。
 * ------------------------------------------------------------------
 *
 * 提供：
 * - GET /admin/liff/random-rice                          dashboard 頁面
 * - GET /admin/liff/random-rice/api/overview             今日概覽
 * - GET /admin/liff/random-rice/api/funnel?days=N        漏斗：開啟活動頁 → 打開地圖 → 看餐廳 → 點訂位
 * - GET /admin/liff/random-rice/api/restaurants?days=N   最多人看的餐廳
 * - GET /admin/liff/random-rice/api/users?days=N         用過的人清單
 * - GET /admin/liff/random-rice/api/audience?days=N      這些人裡面有幾個是現在的 LINE 好友
 * - GET /admin/liff/random-rice/api/trend?days=N         每日趨勢
 */

// ------------------------------------------------------------------
// 行為名稱一律集中在這裡定義，各 API 共用。
// 哪天活動頁又改版，只要改這一段，整頁的數字就會跟著對。
// 每組都把停用的舊名稱一起放進去，拉長區間才不會在改版那天斷掉；
// 但新名稱一定要在裡面，否則近期資料會是 0（這就是這次修的 bug）。
// ------------------------------------------------------------------
const EV_APP_OPEN = ['app_open'];
const EV_MAP_OPEN = ['map_open'];
const EV_VIEW = [
  'map_pin_click',        // 點地圖上的餐廳圖釘
  'map_ext_pin_click',    // 點其他圖釘
  'map_star_pin_click',   // 點星級圖釘
  'map_sheet_item_click', // 點清單裡的餐廳
  'map_restaurant_view',  // 看餐廳詳情
  'restaurant_click'      // 舊版名稱，06-18 之後不再產生，只為歷史資料保留
];
const EV_BOOKING = ['map_booking_click'];
const EV_DECIDE_CLICK = ['map_decide_click', 'submit_draw'];   // submit_draw 為舊名
const EV_DECIDE_RESULT = ['map_decide_result', 'result_shown']; // result_shown 為舊名
const EV_DECIDE_REDRAW = ['map_decide_redraw', 'redraw'];       // redraw 為舊名

// 餐廳名只有這幾種行為帶得齊（properties 的 name 欄位），
// 統計「最多人看的餐廳」用這組；點訂位另外算，用來看哪家真的成交得動。
const EV_RESTAURANT_NAMED = ['map_pin_click', 'map_restaurant_view', 'map_sheet_item_click'];

// 全部都是寫死的常數，不吃外部輸入；仍統一過一次跳脫，避免日後有人往裡面塞變數
function inList(names) {
  return names.map(n => `'` + String(n).replace(/'/g, `''`) + `'`).join(', ');
}

const IN_APP_OPEN = inList(EV_APP_OPEN);
const IN_MAP_OPEN = inList(EV_MAP_OPEN);
const IN_VIEW = inList(EV_VIEW);
const IN_BOOKING = inList(EV_BOOKING);
const IN_DECIDE_CLICK = inList(EV_DECIDE_CLICK);
const IN_DECIDE_RESULT = inList(EV_DECIDE_RESULT);
const IN_DECIDE_REDRAW = inList(EV_DECIDE_REDRAW);
const IN_RESTAURANT_NAMED = inList(EV_RESTAURANT_NAMED);

// 資料庫時區是 UTC，但後台講「今日」指的是台灣的今天，所以日界線要自己換算，
// 不然凌晨那幾個小時會算到前一天去。
const TZ = `'Asia/Taipei'`;
const TODAY_START = `(date_trunc('day', NOW() AT TIME ZONE ${TZ})) AT TIME ZONE ${TZ}`;

function registerAdminLiffAnalyticsRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  // ------------------------------------------------------------------
  // dashboard 頁面
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice', requireAdmin, (req, res) => {
    return res.render('admin_liff_analytics', {
      title: 'LIFF 數據分析 — 今天吃什麼',
      bodyClass: 'admin-shell liff-analytics-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 主選單導引：/admin/liff 沒設子路徑時 → redirect 到 random-rice
  app.get('/admin/liff', requireAdmin, (_req, res) => {
    return res.redirect('/admin/liff/random-rice');
  });

  // ------------------------------------------------------------------
  // API 1: 今日即時概覽
  // 四個階段各給「次數 / 人」，另外附上「幫我決定」的使用狀況。
  // 轉換率固定用「看餐廳 → 點訂位」，因為點訂位才是真正的商業轉換。
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/overview', requireAdmin, async (_req, res) => {
    try {
      const sql = `
        WITH today AS (
          SELECT *
          FROM user_events
          WHERE created_at >= ${TODAY_START}
        )
        SELECT
          -- 開啟活動頁
          COUNT(*) FILTER (WHERE event_name IN (${IN_APP_OPEN})) AS open_events,
          COUNT(DISTINCT session_id) FILTER (WHERE event_name IN (${IN_APP_OPEN})) AS open_visits,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${IN_APP_OPEN}) AND line_id IS NOT NULL) AS open_users,
          -- 打開地圖
          COUNT(*) FILTER (WHERE event_name IN (${IN_MAP_OPEN})) AS map_events,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${IN_MAP_OPEN}) AND line_id IS NOT NULL) AS map_users,
          -- 看餐廳（點圖釘 / 點清單 / 看詳情都算，同一人看多間會分開算）
          COUNT(*) FILTER (WHERE event_name IN (${IN_VIEW})) AS view_events,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${IN_VIEW}) AND line_id IS NOT NULL) AS view_users,
          -- 點訂位（核心轉換）
          COUNT(*) FILTER (WHERE event_name IN (${IN_BOOKING})) AS booking_events,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${IN_BOOKING}) AND line_id IS NOT NULL) AS booking_users,
          -- 幫我決定
          COUNT(*) FILTER (WHERE event_name IN (${IN_DECIDE_CLICK})) AS decide_click_events,
          COUNT(*) FILTER (WHERE event_name IN (${IN_DECIDE_RESULT})) AS decide_result_events,
          COUNT(*) FILTER (WHERE event_name IN (${IN_DECIDE_REDRAW})) AS decide_redraw_events
        FROM today
      `;
      const { rows } = await query(sql);
      const r = rows[0] || {};
      const viewEvents = Number(r.view_events || 0);
      const viewUsers = Number(r.view_users || 0);
      const bookingEvents = Number(r.booking_events || 0);
      const bookingUsers = Number(r.booking_users || 0);
      // 轉換率：次數版 = 點訂位次數 / 看餐廳次數；人版 = 有點訂位的人 / 有看餐廳的人
      const convByEvent = viewEvents > 0
        ? Math.round((bookingEvents / viewEvents) * 10000) / 100 : 0;
      const convByUser = viewUsers > 0
        ? Math.round((bookingUsers / viewUsers) * 10000) / 100 : 0;
      res.json({
        ok: true,
        data: {
          open:    { events: Number(r.open_events || 0), visits: Number(r.open_visits || 0), users: Number(r.open_users || 0) },
          map:     { events: Number(r.map_events || 0),  users: Number(r.map_users || 0) },
          view:    { events: viewEvents,                 users: viewUsers },
          booking: { events: bookingEvents,              users: bookingUsers },
          conv:    { by_event_pct: convByEvent,          by_user_pct: convByUser },
          decide:  {
            click:  Number(r.decide_click_events || 0),
            result: Number(r.decide_result_events || 0),
            redraw: Number(r.decide_redraw_events || 0)
          }
        }
      });
    } catch (err) {
      console.error('liff overview error:', err && err.message);
      res.status(500).json({ ok: false, error: 'overview_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 2: 核心轉換漏斗 — 開啟活動頁 → 打開地圖 → 看餐廳 → 點訂位
  //
  // 順序改成商業上有意義的走法：終點是「點訂位」，那是最接近實際上門的動作。
  // 每一步同時算三種：
  //   來訪（distinct session_id）每筆紀錄都有，最穩，畫面預設看這個
  //   人（distinct line_id）      沒從 LINE 開的人算不出來，會偏低
  //   次數（事件筆數）            同一次來訪點很多間餐廳會累加
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/funnel', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 90, 7);
      const step = (alias, inClause) => `
          COUNT(*) FILTER (WHERE event_name IN (${inClause})) AS ${alias}_events,
          COUNT(DISTINCT session_id) FILTER (WHERE event_name IN (${inClause})) AS ${alias}_sessions,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${inClause}) AND line_id IS NOT NULL) AS ${alias}_users`;
      const sql = `
        SELECT
          ${step('app_open', IN_APP_OPEN)},
          ${step('map_open', IN_MAP_OPEN)},
          ${step('restaurant_view', IN_VIEW)},
          ${step('booking', IN_BOOKING)}
        FROM user_events
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      `;
      const { rows } = await query(sql, [String(days)]);
      const r = rows[0] || {};
      const stepDefs = [
        { key: 'app_open',        label: '開啟活動頁', note: '從 LINE 或連結點進活動頁' },
        { key: 'map_open',        label: '打開地圖',   note: '真的進到地圖畫面開始找店' },
        { key: 'restaurant_view', label: '看餐廳',     note: '點圖釘、點清單裡的餐廳，或看餐廳詳情' },
        { key: 'booking',         label: '點訂位',     note: '按下訂位，最接近真的上門吃飯' }
      ];
      const steps = stepDefs.map(d => ({
        key: d.key,
        label: d.label,
        note: d.note,
        events: Number(r[d.key + '_events'] || 0),
        sessions: Number(r[d.key + '_sessions'] || 0),
        users: Number(r[d.key + '_users'] || 0)
      }));
      // 每種算法都給「相對上一步」「相對第一步」，畫面切換時不用重打 API
      const metrics = ['events', 'sessions', 'users'];
      steps.forEach((s, i) => {
        metrics.forEach(m => {
          if (i === 0) {
            s[m + '_from_prev_pct'] = null;
            s[m + '_from_first_pct'] = 100;
            return;
          }
          const prev = steps[i - 1][m];
          const first = steps[0][m];
          s[m + '_from_prev_pct'] = prev > 0 ? Math.round((s[m] / prev) * 10000) / 100 : 0;
          s[m + '_from_first_pct'] = first > 0 ? Math.round((s[m] / first) * 10000) / 100 : 0;
        });
      });
      res.json({ ok: true, days, data: steps });
    } catch (err) {
      console.error('liff funnel error:', err && err.message);
      res.status(500).json({ ok: false, error: 'funnel_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 2.2: 最多人看的餐廳
  //
  // 餐廳名直接存在紀錄裡（properties 的 name），所以可以直接數。
  // 順便把同一家的「點訂位」也撈出來：看的人多但沒人訂位，跟看的人少卻一直訂位，
  // 是兩種完全不同的合作對象，談約前很有用。
  // tier 是餐廳的合作等級，換成白話標記給後台看。
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/restaurants', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 3650, 30);
      const limit = clampInt(req.query.limit, 1, 100, 10);
      const sql = `
        WITH ev AS (
          SELECT
            NULLIF(BTRIM(properties->>'name'), '') AS name,
            NULLIF(BTRIM(properties->>'tier'), '') AS tier,
            event_name,
            line_id,
            session_id
          FROM user_events
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
            AND event_name IN (${IN_RESTAURANT_NAMED}, ${IN_BOOKING})
        )
        SELECT
          name,
          COUNT(*) FILTER (WHERE event_name IN (${IN_RESTAURANT_NAMED}))::int AS views,
          COUNT(DISTINCT line_id) FILTER (WHERE event_name IN (${IN_RESTAURANT_NAMED}) AND line_id IS NOT NULL)::int AS people,
          COUNT(DISTINCT session_id) FILTER (WHERE event_name IN (${IN_RESTAURANT_NAMED}))::int AS visits,
          COUNT(*) FILTER (WHERE event_name IN (${IN_BOOKING}))::int AS bookings,
          MODE() WITHIN GROUP (ORDER BY tier) AS tier
        FROM ev
        WHERE name IS NOT NULL
        GROUP BY name
        HAVING COUNT(*) FILTER (WHERE event_name IN (${IN_RESTAURANT_NAMED})) > 0
        ORDER BY views DESC, bookings DESC, name ASC
        LIMIT $2
      `;
      const { rows } = await query(sql, [String(days), limit]);
      const data = rows.map(r => ({
        name: r.name,
        views: Number(r.views || 0),
        people: Number(r.people || 0),
        visits: Number(r.visits || 0),
        bookings: Number(r.bookings || 0),
        tier_label: tierLabel(r.tier)
      }));
      res.json({ ok: true, days, count: data.length, data });
    } catch (err) {
      console.error('liff restaurants error:', err && err.message);
      res.status(500).json({ ok: false, error: 'restaurants_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 2.5: 用過的人清單（依 line_id 聚合，JOIN CRM users 拿 line_display_name）
  // 目的：辨識「員工自測 vs 真實用戶」，並看得出誰快要成交
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/users', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 90, 7);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const sql = `
        SELECT
          ue.line_id,
          u.line_display_name,
          u.line_picture_url,
          COUNT(DISTINCT ue.session_id) AS visits,
          COUNT(*) FILTER (WHERE ue.event_name IN (${IN_APP_OPEN})) AS opens,
          COUNT(*) FILTER (WHERE ue.event_name IN (${IN_MAP_OPEN})) AS map_opens,
          COUNT(*) FILTER (WHERE ue.event_name IN (${IN_VIEW})) AS views,
          COUNT(*) FILTER (WHERE ue.event_name IN (${IN_BOOKING})) AS bookings,
          MIN(ue.created_at) AS first_seen,
          MAX(ue.created_at) AS last_seen
        FROM user_events ue
        -- 活動頁的事件從 2026-07-17 起改存「雜湊過的編號」，只比原始編號會全部對不到人
        LEFT JOIN users u ON (u.line_user_id = ue.line_id OR u.line_id_hash = ue.line_id)
        WHERE ue.line_id IS NOT NULL
          AND ue.created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY ue.line_id, u.line_display_name, u.line_picture_url
        ORDER BY MAX(ue.created_at) DESC
        LIMIT $2
      `;
      const { rows } = await query(sql, [String(days), limit]);
      const data = rows.map(r => ({
        line_id: r.line_id,
        display_name: r.line_display_name || null,
        picture_url: r.line_picture_url || null,
        in_crm: Boolean(r.line_display_name),
        visits: Number(r.visits || 0),
        opens: Number(r.opens || 0),
        map_opens: Number(r.map_opens || 0),
        views: Number(r.views || 0),
        bookings: Number(r.bookings || 0),
        first_seen: r.first_seen,
        last_seen: r.last_seen
      }));
      res.json({ ok: true, days, count: data.length, data });
    } catch (err) {
      console.error('liff users error:', err && err.message);
      res.status(500).json({ ok: false, error: 'users_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 2.6: 會員視角 — 玩活動頁的人裡面，有幾個是「現在這個官方帳號的好友」
  //
  // 分成四桶（後台文案一律講白話，不要把下面這些代號寫進畫面）：
  //   member  現行會員：users.archived_at IS NULL 且非管理員 → 現在發得到訊息的人
  //   old     舊官方帳號的人：只對得到已封存(archived_at IS NOT NULL)的舊會員 → 認得是誰但推不到
  //   unknown 對不到任何會員的人
  //   anon    事件沒帶身分（不是從 LINE 裡面開的），連是誰都不知道
  //
  // 會員那一桶直接吃現成的 member_liff_events（已處理明碼 / 雜湊兩種 line_id 對應），
  // 再 JOIN users 過濾封存與管理員，口徑與儀表板「可發送好友」一致。
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/audience', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 3650, 7);
      const limit = clampInt(req.query.limit, 1, 200, 50);

      const bucketSql = `
        WITH ev AS (
          SELECT ue.id, ue.line_id, ue.session_id, ue.event_name
          FROM user_events ue
          WHERE ue.created_at > NOW() - ($1 || ' days')::INTERVAL
        ),
        mem_ev AS (
          SELECT m.event_id, m.user_id
          FROM member_liff_events m
          JOIN users u ON u.id = m.user_id
          WHERE u.archived_at IS NULL
            AND u.is_admin = false
            AND m.created_at > NOW() - ($1 || ' days')::INTERVAL
        ),
        tagged AS (
          SELECT ev.id, ev.line_id, ev.session_id, ev.event_name, mem_ev.user_id
          FROM ev
          LEFT JOIN mem_ev ON mem_ev.event_id = ev.id
        ),
        id_class AS (
          SELECT
            t.line_id,
            BOOL_OR(t.user_id IS NOT NULL) AS is_member,
            EXISTS (
              SELECT 1 FROM users u2
              WHERE (u2.line_user_id = t.line_id OR u2.line_id_hash = t.line_id)
                AND u2.archived_at IS NOT NULL
            ) AS was_old
          FROM tagged t
          WHERE t.line_id IS NOT NULL
          GROUP BY t.line_id
        )
        SELECT
          (SELECT COUNT(DISTINCT user_id) FROM tagged WHERE user_id IS NOT NULL)::int AS member_people,
          (SELECT COUNT(*) FROM tagged WHERE user_id IS NOT NULL)::int AS member_events,
          (SELECT COUNT(*) FROM id_class WHERE NOT is_member AND was_old)::int AS old_people,
          (SELECT COUNT(*) FROM tagged t JOIN id_class c ON c.line_id = t.line_id
             WHERE NOT c.is_member AND c.was_old)::int AS old_events,
          (SELECT COUNT(*) FROM id_class WHERE NOT is_member AND NOT was_old)::int AS unknown_people,
          (SELECT COUNT(*) FROM tagged t JOIN id_class c ON c.line_id = t.line_id
             WHERE NOT c.is_member AND NOT c.was_old)::int AS unknown_events,
          (SELECT COUNT(DISTINCT session_id) FROM tagged WHERE line_id IS NULL)::int AS anon_sessions,
          (SELECT COUNT(*) FROM tagged WHERE line_id IS NULL)::int AS anon_events,
          (SELECT COUNT(*) FROM tagged)::int AS total_events,
          (SELECT COUNT(DISTINCT user_id) FROM tagged
             WHERE user_id IS NOT NULL AND event_name IN (${IN_APP_OPEN}))::int AS act_open,
          (SELECT COUNT(DISTINCT user_id) FROM tagged
             WHERE user_id IS NOT NULL AND event_name IN (${IN_MAP_OPEN}))::int AS act_map,
          (SELECT COUNT(DISTINCT user_id) FROM tagged
             WHERE user_id IS NOT NULL AND event_name IN (${IN_VIEW}))::int AS act_view,
          (SELECT COUNT(DISTINCT user_id) FROM tagged
             WHERE user_id IS NOT NULL AND event_name IN (${IN_BOOKING}))::int AS act_booking
      `;

      const memberSql = `
        SELECT
          u.id AS user_id,
          u.line_user_id,
          u.line_display_name,
          u.line_picture_url,
          COUNT(*)::int AS events,
          COUNT(DISTINCT m.session_id)::int AS visits,
          COUNT(*) FILTER (WHERE m.event_name IN (${IN_APP_OPEN}))::int AS opens,
          COUNT(*) FILTER (WHERE m.event_name IN (${IN_MAP_OPEN}))::int AS map_opens,
          COUNT(*) FILTER (WHERE m.event_name IN (${IN_VIEW}))::int AS views,
          COUNT(*) FILTER (WHERE m.event_name IN (${IN_BOOKING}))::int AS bookings,
          MAX(m.created_at) AS last_seen
        FROM member_liff_events m
        JOIN users u ON u.id = m.user_id
        WHERE u.archived_at IS NULL
          AND u.is_admin = false
          AND m.created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY u.id, u.line_user_id, u.line_display_name, u.line_picture_url
        ORDER BY COUNT(*) DESC, MAX(m.created_at) DESC
        LIMIT $2
      `;

      const [bucketRs, memberRs] = await Promise.all([
        query(bucketSql, [String(days)]),
        query(memberSql, [String(days), limit])
      ]);

      const b = bucketRs.rows[0] || {};
      const memberPeople = Number(b.member_people || 0);
      const oldPeople = Number(b.old_people || 0);
      const unknownPeople = Number(b.unknown_people || 0);

      const members = memberRs.rows.map(r => ({
        line_user_id: r.line_user_id,
        display_name: r.line_display_name || null,
        picture_url: r.line_picture_url || null,
        events: Number(r.events || 0),
        visits: Number(r.visits || 0),
        opens: Number(r.opens || 0),
        map_opens: Number(r.map_opens || 0),
        views: Number(r.views || 0),
        bookings: Number(r.bookings || 0),
        last_seen: r.last_seen
      }));

      res.json({
        ok: true,
        days,
        data: {
          member:  { people: memberPeople,  events: Number(b.member_events || 0) },
          old:     { people: oldPeople,     events: Number(b.old_events || 0) },
          unknown: { people: unknownPeople, events: Number(b.unknown_events || 0) },
          anon:    { sessions: Number(b.anon_sessions || 0), events: Number(b.anon_events || 0) },
          // 有留下身分、可以算成「一個人」的總數（不含完全沒帶身分的紀錄）
          people_with_id: memberPeople + oldPeople + unknownPeople,
          total_events: Number(b.total_events || 0),
          member_actions: {
            open:    Number(b.act_open || 0),
            map:     Number(b.act_map || 0),
            view:    Number(b.act_view || 0),
            booking: Number(b.act_booking || 0)
          },
          members
        }
      });
    } catch (err) {
      console.error('liff audience error:', err && err.message);
      res.status(500).json({ ok: false, error: 'audience_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 3: 每日趨勢 — 來訪 / 用的人 / 看餐廳 / 點訂位 / 轉換率
  // 日界線同樣用台灣時間，才跟畫面上的「今日」對得起來。
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/trend', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 90, 30);
      const sql = `
        WITH d AS (
          SELECT generate_series(
            (date_trunc('day', NOW() AT TIME ZONE ${TZ}) - ($1 - 1 || ' days')::INTERVAL)::date,
            (date_trunc('day', NOW() AT TIME ZONE ${TZ}))::date,
            '1 day'::INTERVAL
          )::date AS day
        ),
        ev AS (
          SELECT
            date_trunc('day', created_at AT TIME ZONE ${TZ})::date AS day,
            line_id,
            session_id,
            event_name
          FROM user_events
          WHERE created_at >= (date_trunc('day', NOW() AT TIME ZONE ${TZ}) - ($1 - 1 || ' days')::INTERVAL) AT TIME ZONE ${TZ}
        )
        SELECT
          d.day,
          COUNT(DISTINCT ev.session_id) FILTER (WHERE ev.event_name IN (${IN_APP_OPEN})) AS visits,
          COUNT(DISTINCT ev.line_id) FILTER (WHERE ev.event_name IN (${IN_APP_OPEN}) AND ev.line_id IS NOT NULL) AS people,
          COUNT(*) FILTER (WHERE ev.event_name IN (${IN_VIEW})) AS views,
          COUNT(*) FILTER (WHERE ev.event_name IN (${IN_BOOKING})) AS bookings
        FROM d
        LEFT JOIN ev ON ev.day = d.day
        GROUP BY d.day
        ORDER BY d.day
      `;
      const { rows } = await query(sql, [days]);
      const data = rows.map(r => {
        const views = Number(r.views || 0);
        const bookings = Number(r.bookings || 0);
        return {
          day: formatYmd(r.day),
          visits: Number(r.visits || 0),
          people: Number(r.people || 0),
          views,
          bookings,
          // 轉換率：看了餐廳之後，有多少比例真的按下訂位
          conversion_rate_pct: views > 0
            ? Math.round((bookings / views) * 10000) / 100
            : 0
        };
      });
      res.json({ ok: true, days, data });
    } catch (err) {
      console.error('liff trend error:', err && err.message);
      res.status(500).json({ ok: false, error: 'trend_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function formatYmd(d) {
  if (!d) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  // pg 回 string 形態 e.g. "2026-05-21"
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// 餐廳的合作等級 → 後台看得懂的白話。沒對到的一律當「一般」，不要漏字。
const TIER_LABELS = {
  cashback: '有回饋',
  offer: '有優惠',
  booking_offer: '訂位有優惠',
  coupon: '有折價券',
  menu: '一般',
  none: '一般'
};

function tierLabel(t) {
  if (!t) return '一般';
  return TIER_LABELS[String(t).trim().toLowerCase()] || '一般';
}

module.exports = { registerAdminLiffAnalyticsRoutes };
