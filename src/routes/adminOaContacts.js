/**
 * 第二個 LINE OA 的聯絡人名單（只讀）。
 *   GET /admin/oa-contacts              頁面
 *   GET /admin/oa-contacts/api/list     JSON：總數/封鎖數 + 最近名單
 *   GET /admin/oa-contacts/export.csv   下載全部名單 CSV
 * 資料來源 oa_contacts（oa_key = 該 OA）。與主 OA 的 /admin/users（LINE 會員 360）分開，互不干擾。
 */
const LIST_LIMIT = 1000;

function csvField(val) {
  let s = String(val == null ? '' : val);
  // 中和 CSV 公式注入：display_name 是陌生人自設的 LINE 暱稱（可控），
  // 若以 = + - @（或前導 tab/CR）開頭，Excel/Sheets 開檔會當公式執行。前置單引號即可中和。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function registerAdminOaContactsRoutes(app, deps) {
  const { query, authCore, oaKey = 'oa2' } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin/oa-contacts', requireAdmin, (req, res) => {
    res.render('admin_oa_contacts', {
      title: '新 OA 名單',
      bodyClass: 'admin-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      oaKey
    });
  });

  app.get('/admin/oa-contacts/api/list', requireAdmin, async (req, res) => {
    try {
      const stats = await query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE blocked_at IS NULL)::int AS active,
                count(*) FILTER (WHERE blocked_at IS NOT NULL)::int AS blocked
         FROM oa_contacts WHERE oa_key = $1`,
        [oaKey]
      );
      const rows = await query(
        `SELECT line_user_id, display_name, picture_url, first_seen_at, last_event_at, blocked_at
         FROM oa_contacts WHERE oa_key = $1
         ORDER BY last_event_at DESC
         LIMIT ${LIST_LIMIT}`,
        [oaKey]
      );
      const s = stats.rows[0] || { total: 0, active: 0, blocked: 0 };
      res.json({
        ok: true,
        stats: s,
        limit: LIST_LIMIT,
        contacts: rows.rows.map(r => ({
          lineUserId: r.line_user_id,
          displayName: r.display_name,
          pictureUrl: r.picture_url,
          firstSeenAt: r.first_seen_at,
          lastEventAt: r.last_event_at,
          blocked: r.blocked_at != null
        }))
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'list_failed', detail: '系統忙碌，請稍後再試' });
    }
  });

  app.get('/admin/oa-contacts/export.csv', requireAdmin, async (req, res) => {
    try {
      const rows = await query(
        `SELECT line_user_id, display_name, first_seen_at, last_event_at, blocked_at
         FROM oa_contacts WHERE oa_key = $1
         ORDER BY last_event_at DESC`,
        [oaKey]
      );
      const header = 'line_user_id,display_name,first_seen_at,last_event_at,blocked\n';
      const body = rows.rows.map(r => [
        csvField(r.line_user_id),
        csvField(r.display_name),
        csvField(r.first_seen_at ? new Date(r.first_seen_at).toISOString() : ''),
        csvField(r.last_event_at ? new Date(r.last_event_at).toISOString() : ''),
        csvField(r.blocked_at ? 'blocked' : 'active')
      ].join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="oa-contacts-${oaKey}.csv"`);
      res.send('﻿' + header + body + '\n'); // 加 BOM 讓 Excel 正確顯示中文
    } catch (err) {
      res.status(500).send('export failed');
    }
  });
}

module.exports = { registerAdminOaContactsRoutes };
