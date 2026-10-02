const { SOURCES, RECOVERED_SQL, decoratePush, taipeiTime, csvCell } = require('../core/pushLogDiagnostics');
const PAGE_SIZE = 50;
const EXPORT_LIMIT = 10000;

function parseFilters(raw = {}, now = new Date()) {
  const scalar = key => typeof raw[key] === 'string' ? raw[key] : '';
  const status = scalar('status') || 'failed';
  const range = scalar('range') || '24h';
  const source = scalar('source').slice(0, 64);
  if (!['failed', 'success', 'skipped', 'all'].includes(status) || !['24h', '7d', '30d', '90d', 'all', 'custom'].includes(range)) throw new Error('請選擇有效的狀態與期間。');
  if (source && !/^[a-zA-Z0-9_-]+$/.test(source)) throw new Error('訊息來源格式不正確。');
  const followup = scalar('followup') || 'all';
  if (!['all', 'pending', 'recovered'].includes(followup)) throw new Error('請選擇有效的後續狀態。');
  const filters = { status, range, source, followup: status === 'failed' ? followup : 'all', q: scalar('q').trim().slice(0, 120), from: scalar('from'), to: scalar('to'), after: scalar('after'), beforeId: scalar('beforeId') };
  const values = [], parts = [];
  const bind = value => { values.push(value); return '$' + values.length; };
  if (status !== 'all') parts.push(`l.status = ${bind(status)}`);
  if (filters.followup !== 'all') parts.push(filters.followup === 'recovered' ? RECOVERED_SQL : `NOT ${RECOVERED_SQL}`);
  if (range !== 'all' && range !== 'custom') {
    const ms = ({ '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000, '90d': 90 * 86400000 })[range];
    parts.push(`l.created_at >= ${bind(new Date(now.getTime() - ms).toISOString())}::timestamptz`);
  }
  if (range === 'custom') {
    function day(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') throw new Error('請填寫有效的開始與結束日期。');
      const d = new Date(value + 'T00:00:00Z');
      if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error('請填寫有效日期。');
      return d;
    }
    const from = day(filters.from), to = day(filters.to);
    if (to < from || (to - from) / 86400000 > 365) throw new Error('結束日期不可早於開始日期；一次最多查 366 天。');
    parts.push(`l.created_at >= ${bind(filters.from + 'T00:00:00+08:00')}::timestamptz`);
    parts.push(`l.created_at < ${bind(new Date(to.getTime() + 86400000).toISOString().slice(0, 10) + 'T00:00:00+08:00')}::timestamptz`);
  }
  if (source) parts.push(`l.push_type = ${bind(source)}`);
  if (filters.q) {
    const term = bind('%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%');
    parts.push(`(l.line_user_id ILIKE ${term} ESCAPE E'\\\\' OR l.detail ILIKE ${term} ESCAPE E'\\\\' OR EXISTS (
      SELECT 1 FROM users u WHERE (u.id = l.user_id OR u.line_user_id = l.line_user_id)
      AND (u.username ILIKE ${term} ESCAPE E'\\\\' OR u.line_display_name ILIKE ${term} ESCAPE E'\\\\'))) `);
  }
  const where = parts.length ? parts.join(' AND ') : 'TRUE';
  if (filters.after || filters.beforeId) {
    if (!/^\d{1,15}$/.test(filters.beforeId) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(filters.after) || !Number.isFinite(new Date(filters.after).getTime())) throw new Error('分頁資訊已失效，請重新套用篩選。');
  }
  return { filters, values, where };
}

function filterUrl(filters, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, after: '', beforeId: '', ...extra })) if (value !== '' && value != null) params.set(key, String(value));
  return '/admin/push-logs?' + params.toString();
}

// Source IDs are metadata only. Validate before casting so malformed historic payloads cannot break the page.
function metadataId(field, fallback) {
  const expression = `COALESCE(l.payload->>'${field}', ${fallback || 'NULL'})`;
  return `CASE WHEN ${expression} ~ '^[0-9]{1,15}$' THEN (${expression})::bigint ELSE NULL END`;
}
function detailSql(where, limitBind, cursor = '') {
  const enrollment = metadataId('enrollmentId', "substring(l.payload->>'retryKey' from '^flow-([0-9]+)-')");
  const batch = metadataId('broadcastId', "substring(l.payload->>'retryKey' from '^bc-([0-9]+)-')");
  return `WITH selected_logs AS (
    SELECT l.* FROM line_push_logs l WHERE ${where} ${cursor}
    ORDER BY l.created_at DESC, l.id DESC LIMIT ${limitBind}
  ) SELECT l.*, to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
    u.line_display_name, u.username, u.blocked_at, u.archived_at,
    e.status AS flow_status, e.next_run_at, f.id AS flow_id, f.name AS flow_name,
    b.id AS broadcast_id, l.payload->>'activityName' AS activity_name,
    ${RECOVERED_SQL} AS recovered
    FROM selected_logs l
    LEFT JOIN LATERAL (SELECT id, line_display_name, username, blocked_at, archived_at FROM users
      WHERE id = l.user_id OR (NULLIF(l.line_user_id, '') IS NOT NULL AND line_user_id = l.line_user_id)
      ORDER BY (id = l.user_id) DESC NULLS LAST, id DESC LIMIT 1) u ON TRUE
    LEFT JOIN admin_flow_enrollments e ON e.id = ${enrollment}
    LEFT JOIN admin_flows f ON f.id = e.flow_id
    LEFT JOIN admin_broadcasts b ON b.id = ${batch}
    ORDER BY l.created_at DESC, l.id DESC`;
}

function registerAdminPushLogsRoutes(app, { query, authCore }) {
  app.get('/admin/push-logs', authCore.requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    let parsed;
    const base = { user: (req.authUser && req.authUser.un) || '', isAdmin: true, title: '推播發送紀錄', SOURCES, taipeiTime, filterUrl };
    try {
      parsed = parseFilters(req.query);
    } catch (err) {
      return res.status(400).render('admin_push_logs', { ...base, filters: parseFilters().filters, stats: {}, rows: [], nextHref: '', error: err.message });
    }
    const { filters, where } = parsed;
    try {
      const summary = await query(`SELECT COUNT(*)::int AS total,
        COUNT(DISTINCT COALESCE(NULLIF(l.line_user_id,''), 'user:' || l.user_id::text))::int AS people,
        COUNT(*) FILTER (WHERE l.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE ${RECOVERED_SQL})::int AS recovered,
        COUNT(*) FILTER (WHERE l.status = 'failed' AND l.http_status = 429 AND l.detail ILIKE '%monthly limit%')::int AS monthly
        FROM line_push_logs l WHERE ${where}`, parsed.values);
      const stats = summary.rows[0] || {};
      const exporting = req.query.export === 'csv';
      if (exporting && Number(stats.total) > EXPORT_LIMIT) {
        return res.status(413).render('admin_push_logs', { ...base, filters, stats, rows: [], nextHref: '', error: '一次最多匯出 10,000 筆。請縮短日期或加上來源／收件人條件後再匯出。' });
      }
      const values = [...parsed.values];
      let cursor = '';
      if (!exporting && filters.after) {
        values.push(filters.after, filters.beforeId);
        cursor = `AND (l.created_at, l.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
      }
      values.push(exporting ? EXPORT_LIMIT + 1 : PAGE_SIZE + 1);
      const result = await query(detailSql(where, '$' + values.length, cursor), values);
      if (exporting && result.rows.length > EXPORT_LIMIT) return res.status(413).send('紀錄已增加，超過 10,000 筆；請縮短期間後重新匯出。');
      const rows = result.rows.slice(0, exporting ? EXPORT_LIMIT : PAGE_SIZE).map(decoratePush);
      if (exporting) {
        const header = ['紀錄編號', '時間（台灣）', '收件人', 'LINE User ID', '訊息來源', '訊息內容摘要', '發送狀態', 'HTTP 狀態', '原因', '下一步', '後續狀態', 'LINE 原始回應'];
        const csv = [header, ...rows.map(r => [r.id, taipeiTime(r.created_at), r.person, r.line_user_id, r.source, r.message, r.status, r.http_status, r.cause, r.action, r.followUp, r.detail])].map(r => r.map(csvCell).join(',')).join('\r\n');
        res.setHeader('Content-Disposition', 'attachment; filename="line-push-logs.csv"');
        return res.type('text/csv; charset=utf-8').send('\uFEFF' + csv);
      }
      const last = rows[rows.length - 1];
      const nextHref = result.rows.length > PAGE_SIZE && last ? filterUrl(filters, { after: last.cursor_time, beforeId: last.id }) : '';
      return res.render('admin_push_logs', { ...base, filters, stats, rows, nextHref, error: '' });
    } catch (err) {
      console.error('push log diagnostics unavailable:', err && err.code || 'query_failed');
      return res.status(500).render('admin_push_logs', { ...base, filters, stats: {}, rows: [], nextHref: '', error: '暫時讀不到發送紀錄，不代表沒有失敗。請稍後重新整理；若持續發生，請管理員檢查資料庫連線。' });
    }
  });
}
module.exports = { registerAdminPushLogsRoutes, parseFilters, filterUrl, detailSql, PAGE_SIZE, EXPORT_LIMIT };
