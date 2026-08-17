/**
 * 後台首頁（儀表板）— 登入後的落地頁
 *
 *   GET /admin                關鍵數字 + 三步驟引導 + 快速入口
 *   GET /admin/api/dashboard  統計 JSON
 */

function registerAdminDashboardRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin', requireAdmin, (req, res) => {
    res.render('admin_dashboard', {
      title: '首頁',
      bodyClass: 'admin-shell dashboard-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/api/dashboard', requireAdmin, async (req, res) => {
    try {
      const rs = await query(`
        SELECT
          -- archived_at IS NULL：只算現行 OA 的好友。已封存＝舊 OA 的歷史會員，
          -- 其 line_user_id 對現行 OA 無效、推不到，計入會讓儀表板數字失真。
          (SELECT COUNT(*)::int FROM users
            WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
              AND is_admin = false AND blocked_at IS NULL AND archived_at IS NULL) AS friends,
          (SELECT COUNT(*)::int FROM users
            WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
              AND is_admin = false AND blocked_at IS NULL AND archived_at IS NULL
              AND created_at > now() - interval '7 days') AS friends_7d,
          (SELECT COUNT(*)::int FROM activities WHERE status = 'active') AS active_activities,
          (SELECT COUNT(*)::int FROM admin_flows WHERE status = 'active') AS active_flows,
          (SELECT COUNT(*)::int FROM admin_message_templates WHERE channel = 'line') AS templates
      `);
      const lastRs = await query(`
        SELECT id, created_at, status, recipient_total, recipient_ok, recipient_fail
        FROM admin_broadcasts
        WHERE status IN ('done','sending','running','scheduled','failed')
        ORDER BY id DESC LIMIT 1
      `);
      // 「需要你注意」紅旗：近 24h 推播失敗筆數、失敗的群發批次數
      // （刻意不含「邀請漏發獎」：那是春日 line_invites 的歷史殘留、活動已結束且已人工處理，
      //   會永遠卡在固定數字一直誤報；新版 MGM 走 activity_referrals + 即時通知，不需此提醒）
      const alertRs = await query(`
        SELECT
          (SELECT COUNT(*)::int FROM line_push_logs
            WHERE status = 'failed' AND created_at >= NOW() - interval '24 hours') AS push_failed_24h,
          -- status='failed' 從來沒有程式路徑會寫入（整批失敗最後也是 done），
          -- 真正要盯的是「已結案但有失敗收件人」的批次
          (SELECT COUNT(*)::int FROM admin_broadcasts b
            WHERE b.status = 'done' AND b.recipient_fail > 0
              AND b.finished_at >= NOW() - interval '7 days') AS broadcasts_failed
      `);
      const a = alertRs.rows[0] || {};
      const alerts = {
        push_failed_24h: Number(a.push_failed_24h || 0),
        broadcasts_failed: Number(a.broadcasts_failed || 0)
      };
      const liff = await loadLiffStats(query);
      const booking = await loadBookingSource(query);
      return res.json({ ok: true, stats: rs.rows[0], lastBroadcast: lastRs.rows[0] || null, alerts, liff, booking });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'dashboard_failed', detail: err && err.message });
    }
  });
}

/**
 * 活動頁（好康地圖 / 擲骰子選餐廳）近 7 天的三個數字。
 *
 * - opens_7d   開啟次數（app_open 事件）
 * - users_7d   用過的人：同一個人多次使用只算一次（只能算有帶身分的）
 * - members_7d 其中是「現在這個官方帳號的好友」的人數
 * - anon_7d    沒帶身分、算不出是誰的使用筆數（不是從 LINE 裡面打開的）
 *
 * 口徑與上面的「可發送好友」一致：archived_at IS NULL（排除舊官方帳號留下的歷史會員）
 * 且非管理員，避免把推不到訊息的人算進來。
 *
 * 這段刻意獨立 try/catch：活動頁資料是加值資訊，讀不到也不該讓整個首頁掛掉。
 */
async function loadLiffStats(query) {
  try {
    const rs = await query(`
      WITH ev AS (
        SELECT line_id, event_name
        FROM user_events
        WHERE created_at > NOW() - interval '7 days'
      )
      SELECT
        (SELECT COUNT(*) FROM ev WHERE event_name = 'app_open')::int AS opens_7d,
        (SELECT COUNT(DISTINCT line_id) FROM ev WHERE line_id IS NOT NULL)::int AS users_7d,
        (SELECT COUNT(*) FROM ev WHERE line_id IS NULL)::int AS anon_7d,
        (SELECT COUNT(DISTINCT m.user_id)
           FROM member_liff_events m
           JOIN users u ON u.id = m.user_id
          WHERE u.archived_at IS NULL
            AND u.is_admin = false
            AND m.created_at > NOW() - interval '7 days')::int AS members_7d
    `);
    const r = rs.rows[0] || {};
    return {
      opens_7d: Number(r.opens_7d || 0),
      users_7d: Number(r.users_7d || 0),
      anon_7d: Number(r.anon_7d || 0),
      members_7d: Number(r.members_7d || 0)
    };
  } catch (err) {
    console.error('dashboard liff stats failed:', err && err.message);
    return null;
  }
}

/**
 * 訂位來源調查：會員在官方帳號的圖文選單回答「平常都從哪裡訂位」的結果。
 *
 * 直接讀現成的 member_booking_source（每個人只留最新一筆回答），
 * 不要自己去翻 booking_source_answers 原始表，免得同一個人改過答案被重複計算。
 *
 * 回傳兩個口徑，前端要並排標清楚：
 * - total    回答過的總人數（含舊官方帳號時期回答的人）
 * - current  其中是「現在這個官方帳號的好友」的人數
 *
 * 這份調查大多是在舊官方帳號時期做的，所以 current 會遠小於 total，這是正常的。
 * current 的認定與本頁其他數字一致：archived_at IS NULL（排除舊官方帳號留下的歷史會員）
 * 且非管理員。users.line_user_id 有唯一性，LEFT JOIN 不會讓某一列被算成兩次。
 *
 * 這段刻意獨立 try/catch：訂位來源是加值資訊，讀不到也不該讓整個首頁掛掉。
 */
async function loadBookingSource(query) {
  try {
    const rs = await query(`
      SELECT
        b.source_label AS label,
        COUNT(*)::int AS total,
        COUNT(u.id)::int AS current_members
      FROM member_booking_source b
      LEFT JOIN users u
        ON u.line_user_id = b.line_user_id
       AND u.archived_at IS NULL
       AND u.is_admin = false
      GROUP BY b.source_label
      ORDER BY COUNT(*) DESC, b.source_label ASC
    `);
    const items = (rs.rows || []).map((r) => ({
      label: String(r.label == null ? '' : r.label).trim() || '沒寫來源',
      total: Number(r.total || 0),
      current: Number(r.current_members || 0)
    }));
    return {
      items,
      total: items.reduce((sum, it) => sum + it.total, 0),
      current: items.reduce((sum, it) => sum + it.current, 0)
    };
  } catch (err) {
    console.error('dashboard booking source failed:', err && err.message);
    return null;
  }
}

module.exports = { registerAdminDashboardRoutes };
