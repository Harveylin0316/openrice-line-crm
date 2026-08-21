/**
 * 數據總覽 —— 對標 LINE 官方後台的「分析」，再加上官方看不到的：
 *   官方有的：好友數／可觸及／封鎖、性別年齡地區輪廓、訊息量（LINE 統計 API）
 *   官方沒有的：好友成長曲線（我們自己的 webhook 資料，完整歷史）、
 *               圖文選單每格點擊、活動遊玩與邀請、加入來源，全部在同一頁。
 *
 *   GET /admin/insight            頁面
 *   GET /admin/insight/api/data   ?days=30|90
 */

function registerAdminInsightRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;
  const jsonErr = (res, s, e, extra = {}) => res.status(s).json({ ok: false, error: e, ...extra });
  const token = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

  async function lineGet(path) {
    const resp = await fetch('https://api.line.me' + path, {
      headers: { Authorization: 'Bearer ' + token() }
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
    if (!resp.ok) { const err = new Error('LINE ' + resp.status); err.status = resp.status; throw err; }
    return json;
  }

  app.get('/admin/insight', requireAdmin, (req, res) => {
    res.render('admin_insight', {
      title: '數據總覽',
      bodyClass: 'admin-shell insight-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/insight/api/data', requireAdmin, async (req, res) => {
    try {
      const days = Number(req.query.days) === 90 ? 90 : 30;

      // ── LINE 官方統計（掛了任何一支都不擋整頁）──
      // 官方數字以「昨天」為準（LINE 當天的還沒結算）
      const y = new Date(Date.now() - 24 * 3600 * 1000);
      const ymd = y.toISOString().slice(0, 10).replace(/-/g, '');
      let lineFollowers = null, demographic = null, delivery = null;
      try { lineFollowers = await lineGet('/v2/bot/insight/followers?date=' + ymd); } catch (e) { /* 照樣出頁 */ }
      try { demographic = await lineGet('/v2/bot/insight/demographic'); } catch (e) { /* 同上 */ }
      try { delivery = await lineGet('/v2/bot/insight/message/delivery?date=' + ymd); } catch (e) { /* 同上 */ }

      // ── 我們自己的資料 ──
      const daily = (await query(
        `WITH d AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Taipei')::date - ($1::int - 1),
                                           (now() AT TIME ZONE 'Asia/Taipei')::date, '1 day') AS day)
         SELECT to_char(d.day, 'MM/DD') AS day,
           (SELECT COUNT(*)::int FROM users u
             WHERE (u.created_at AT TIME ZONE 'Asia/Taipei')::date = d.day
               AND u.line_user_id IS NOT NULL AND u.is_admin = false) AS joins,
           (SELECT COUNT(*)::int FROM users u
             WHERE (u.blocked_at AT TIME ZONE 'Asia/Taipei')::date = d.day) AS blocks,
           (SELECT COUNT(*)::int FROM line_webhook_events e
             WHERE e.event_type = 'message'
               AND (e.created_at AT TIME ZONE 'Asia/Taipei')::date = d.day) AS msgs,
           (SELECT COUNT(*)::int FROM rich_menu_taps t
             WHERE (t.created_at AT TIME ZONE 'Asia/Taipei')::date = d.day) AS menu_taps,
           (SELECT COUNT(*)::int FROM activity_plays p
             WHERE COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win'
               AND (p.played_at AT TIME ZONE 'Asia/Taipei')::date = d.day) AS plays,
           (SELECT COUNT(*)::int FROM activity_referrals r
             WHERE r.invitee_was_existing IS FALSE
               AND (r.created_at AT TIME ZONE 'Asia/Taipei')::date = d.day) AS referrals
         FROM d ORDER BY d.day`, [days])).rows;

      const totals = (await query(
        `SELECT COUNT(*) FILTER (WHERE line_user_id IS NOT NULL AND is_admin = false)::int AS members,
                COUNT(*) FILTER (WHERE blocked_at IS NOT NULL)::int AS blocked,
                COUNT(*) FILTER (WHERE line_user_id IS NOT NULL AND is_admin = false
                                   AND created_at >= now() - ($1::int || ' days')::interval)::int AS joined_period
           FROM users`, [days])).rows[0];

      const sources = (await query(
        `SELECT source_key, COUNT(*)::int AS n
           FROM line_follow_sources GROUP BY source_key ORDER BY n DESC LIMIT 12`)).rows;

      const topButtons = (await query(
        `SELECT t.menu_id, t.tab, t.cell, t.kind, COALESCE(t.label, '') AS label,
                m.name AS menu_name, COUNT(*)::int AS taps
           FROM rich_menu_taps t LEFT JOIN rich_menus m ON m.id = t.menu_id
          WHERE t.created_at >= now() - interval '30 days'
          GROUP BY t.menu_id, t.tab, t.cell, t.kind, t.label, m.name
          ORDER BY taps DESC LIMIT 10`)).rows;

      const activities = (await query(
        `SELECT a.name, COUNT(*)::int AS plays,
                COUNT(*) FILTER (WHERE COALESCE(p.prize_snapshot->>'prize_type','') <> 'none')::int AS wins,
                COUNT(DISTINCT p.line_user_id)::int AS people
           FROM activity_plays p JOIN activities a ON a.id = p.activity_id
          WHERE p.played_at >= now() - ($1::int || ' days')::interval
            AND COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win'
          GROUP BY a.name ORDER BY plays DESC LIMIT 8`, [days])).rows;

      res.json({
        ok: true, days,
        line: {
          followers: lineFollowers,     // { followers, targetedReaches, blocks } 或 null
          demographic,                  // { genders, ages, areas, appTypes... } 或 null
          delivery                      // 昨天各類訊息量 或 null
        },
        totals, daily, sources, top_buttons: topButtons, activities
      });
    } catch (err) {
      console.error('insight data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });
}

module.exports = { registerAdminInsightRoutes };
