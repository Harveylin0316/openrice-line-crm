/**
 * 數據總覽：LINE 官方統計 + CRM 自有互動資料。
 * GET /admin/insight/api/data 支援 ?from=YYYY-MM-DD&to=YYYY-MM-DD；舊的 ?days=1..365 仍相容。
 */

const MAX_EXACT_RANGE_DAYS = 397;
const MAX_RICH_MENU_IDS = 12;
const RICH_MENU_CACHE_MS = 15 * 60 * 1000;

function registerAdminInsightRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;
  const jsonErr = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
  const token = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const richMenuCache = new Map();

  async function lineGet(path) {
    const resp = await fetch('https://api.line.me' + path, {
      headers: { Authorization: 'Bearer ' + token() }
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
    if (!resp.ok) {
      const err = new Error('LINE ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return json;
  }

  async function cachedRichMenuSummary(richMenuId, from, to) {
    const key = richMenuId + ':' + from + ':' + to;
    const now = Date.now();
    const cached = richMenuCache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;
    const promise = lineGet('/v2/bot/insight/richmenu/' + encodeURIComponent(richMenuId) +
      '/summary?from=' + compactDate(from) + '&to=' + compactDate(to));
    richMenuCache.set(key, { expiresAt: now + RICH_MENU_CACHE_MS, promise });
    try { return await promise; }
    catch (err) { richMenuCache.delete(key); throw err; }
  }

  async function getRichMenuInsight(range) {
    if (!token()) return emptyRichMenuInsight(range, 'not_configured');

    // LINE 的圖文選單統計以 UTC+9 曆日彙整，通常隔天完成，因此最多查到昨天。
    const lineReadyThrough = addDaysIso(calendarDate(Date.now(), 9), -1);
    const lineTo = range.to < lineReadyThrough ? range.to : lineReadyThrough;
    if (lineTo < range.from) return emptyRichMenuInsight(range, 'not_ready', { line_to: lineTo });

    let rows;
    try {
      rows = (await query(
        `SELECT id, name, line_rich_menu_id, line_rich_menu_ids, is_default, updated_at
           FROM rich_menus
          WHERE status = 'published' AND line_rich_menu_id IS NOT NULL
          ORDER BY is_default DESC, updated_at DESC
          LIMIT 100`)).rows;
    } catch (err) {
      return emptyRichMenuInsight(range, 'menu_lookup_failed', { line_to: lineTo });
    }

    const pages = [];
    const seen = new Set();
    for (const row of rows) {
      const ids = Array.isArray(row.line_rich_menu_ids) && row.line_rich_menu_ids.length
        ? row.line_rich_menu_ids
        : [{ id: row.line_rich_menu_id, tab: 0 }];
      for (const entry of ids) {
        const id = String(entry && entry.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        pages.push({
          menu_id: row.id,
          menu_name: row.name,
          tab: Number.isInteger(Number(entry.tab)) ? Number(entry.tab) + 1 : 1,
          is_default: row.is_default === true,
          line_id: id
        });
      }
    }

    if (!pages.length) return emptyRichMenuInsight(range, 'no_published_menu', { line_to: lineTo });
    const limited = pages.slice(0, MAX_RICH_MENU_IDS);
    const results = await Promise.all(limited.map(async page => {
      try {
        const raw = await cachedRichMenuSummary(page.line_id, range.from, lineTo);
        const metrics = raw && raw.impression && raw.impression.metrics;
        if (!metrics || metrics.count == null || !Number.isFinite(Number(metrics.count))) {
          return { ...page, status: 'privacy_limited', impressions: null, unique_users: null };
        }
        return {
          ...page,
          status: 'ok',
          impressions: Number(metrics.count),
          unique_users: metrics.uniqueUsers != null && Number.isFinite(Number(metrics.uniqueUsers))
            ? Number(metrics.uniqueUsers) : null,
          metrics_from: expandDate(raw.metricsFrom),
          metrics_to: expandDate(raw.metricsTo)
        };
      } catch (err) {
        let status = err && err.status === 429 ? 'rate_limited' : 'unavailable';
        if (err && err.status === 404) {
          // insight 的 404 不一定代表選單被刪除：新選單可能已存在，但 LINE 尚未產生統計。
          // 再查選單本體，避免畫面把仍在使用中的選單誤報成「版本已刪除」。
          try {
            await lineGet('/v2/bot/richmenu/' + encodeURIComponent(page.line_id));
            status = 'not_ready';
          } catch (lookupErr) {
            status = lookupErr && lookupErr.status === 404 ? 'deleted' : 'unavailable';
          }
        }
        return {
          ...page,
          status,
          impressions: null,
          unique_users: null
        };
      }
    }));

    const successful = results.filter(x => x.status === 'ok');
    const metricStarts = successful.map(x => x.metrics_from).filter(Boolean).sort();
    const metricEnds = successful.map(x => x.metrics_to).filter(Boolean).sort();
    return {
      available: successful.length > 0,
      reason: successful.length ? null : inferRichMenuReason(results),
      total_impressions: successful.length
        ? successful.reduce((sum, x) => sum + x.impressions, 0)
        : null,
      // LINE rich menu id 不必送到瀏覽器；管理頁只需要 CRM 選單名稱與分頁。
      pages: results.map(({ line_id, ...safe }) => safe),
      requested_from: range.from,
      requested_to: range.to,
      line_to: lineTo,
      metrics_from: metricStarts.length ? metricStarts[0] : null,
      metrics_to: metricEnds.length ? metricEnds[metricEnds.length - 1] : null,
      partial: successful.length > 0 && successful.length < results.length,
      truncated: pages.length > limited.length,
      menu_pages_found: pages.length
    };
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
    let range;
    try { range = normalizeDateRange(req.query || {}); }
    catch (err) { return jsonErr(res, 400, 'bad_range', { detail: err.message }); }

    try {
      // 這三支 LINE API 任一失敗都不阻擋 CRM 自有統計。
      const ymd = compactDate(addDaysIso(calendarDate(Date.now(), 9), -1));
      let lineFollowers = null, demographic = null, delivery = null;
      try { lineFollowers = await lineGet('/v2/bot/insight/followers?date=' + ymd); } catch (e) { /* 照樣出頁 */ }
      try { demographic = await lineGet('/v2/bot/insight/demographic'); } catch (e) { /* 照樣出頁 */ }
      try { delivery = await lineGet('/v2/bot/insight/message/delivery?date=' + ymd); } catch (e) { /* 照樣出頁 */ }

      const params = [range.from, range.to];
      const daily = (await query(
        `WITH bounds AS (SELECT $1::date AS start, $2::date AS finish),
         d AS (
           SELECT generate_series(bounds.start, bounds.finish, '1 day')::date AS day FROM bounds
         ),
         counts AS (
           SELECT (u.created_at AT TIME ZONE 'Asia/Taipei')::date AS day,
                  COUNT(*)::int AS joins, 0::int AS blocks, 0::int AS msgs,
                  0::int AS menu_taps, 0::int AS plays, 0::int AS referrals
             FROM users u, bounds
            WHERE (u.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish
              AND u.line_user_id IS NOT NULL AND u.is_admin = false
            GROUP BY 1
           UNION ALL
           SELECT (u.blocked_at AT TIME ZONE 'Asia/Taipei')::date, 0, COUNT(*)::int, 0, 0, 0, 0
             FROM users u, bounds
            WHERE (u.blocked_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish GROUP BY 1
           UNION ALL
           SELECT (e.created_at AT TIME ZONE 'Asia/Taipei')::date, 0, 0, COUNT(*)::int, 0, 0, 0
             FROM line_webhook_events e, bounds
            WHERE (e.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish
              AND e.event_type = 'message' GROUP BY 1
           UNION ALL
           SELECT (t.created_at AT TIME ZONE 'Asia/Taipei')::date, 0, 0, 0, COUNT(*)::int, 0, 0
             FROM rich_menu_taps t, bounds
            WHERE (t.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish GROUP BY 1
           UNION ALL
           SELECT (p.played_at AT TIME ZONE 'Asia/Taipei')::date, 0, 0, 0, 0, COUNT(*)::int, 0
             FROM activity_plays p, bounds
            WHERE (p.played_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish
              AND COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win' GROUP BY 1
           UNION ALL
           SELECT (r.created_at AT TIME ZONE 'Asia/Taipei')::date, 0, 0, 0, 0, 0, COUNT(*)::int
             FROM activity_referrals r, bounds
            WHERE (r.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN bounds.start AND bounds.finish
              AND r.invitee_was_existing IS FALSE GROUP BY 1
         )
         SELECT to_char(d.day, 'MM/DD') AS day,
                COALESCE(SUM(c.joins), 0)::int AS joins,
                COALESCE(SUM(c.blocks), 0)::int AS blocks,
                COALESCE(SUM(c.msgs), 0)::int AS msgs,
                COALESCE(SUM(c.menu_taps), 0)::int AS menu_taps,
                COALESCE(SUM(c.plays), 0)::int AS plays,
                COALESCE(SUM(c.referrals), 0)::int AS referrals
           FROM d LEFT JOIN counts c ON c.day = d.day
          GROUP BY d.day ORDER BY d.day`, params)).rows;

      const totals = (await query(
        `SELECT COUNT(*) FILTER (WHERE line_user_id IS NOT NULL AND is_admin = false
                                   AND archived_at IS NULL)::int AS members,
                COUNT(*) FILTER (WHERE blocked_at IS NOT NULL AND archived_at IS NULL)::int AS blocked,
                COUNT(*) FILTER (WHERE line_user_id IS NOT NULL AND is_admin = false
                                   AND archived_at IS NULL
                                   AND (created_at AT TIME ZONE 'Asia/Taipei')::date
                                       BETWEEN $1::date AND $2::date)::int AS joined_period
           FROM users`, params)).rows[0];

      const sources = (await query(
        `SELECT source_key, COUNT(*)::int AS n
           FROM line_follow_sources
          WHERE (updated_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
          GROUP BY source_key ORDER BY n DESC LIMIT 12`, params)).rows;

      const topButtons = (await query(
        `SELECT t.menu_id, t.tab, t.cell, t.kind, COALESCE(t.label, '') AS label,
                m.name AS menu_name, COUNT(*)::int AS taps
           FROM rich_menu_taps t LEFT JOIN rich_menus m ON m.id = t.menu_id
          WHERE (t.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
          GROUP BY t.menu_id, t.tab, t.cell, t.kind, t.label, m.name
          ORDER BY taps DESC LIMIT 10`, params)).rows;

      const activities = (await query(
        `SELECT a.name, COUNT(*)::int AS plays,
                COUNT(*) FILTER (WHERE COALESCE(p.prize_snapshot->>'prize_type','') <> 'none')::int AS wins,
                COUNT(DISTINCT p.line_user_id)::int AS people
           FROM activity_plays p JOIN activities a ON a.id = p.activity_id
          WHERE (p.played_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
            AND COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win'
          GROUP BY a.name ORDER BY plays DESC LIMIT 8`, params)).rows;

      const richMenuInsight = await getRichMenuInsight(range);
      res.json({
        ok: true,
        days: range.days,
        range,
        line: {
          followers: lineFollowers,
          demographic,
          delivery,
          rich_menu: richMenuInsight
        },
        totals, daily, sources, top_buttons: topButtons, activities
      });
    } catch (err) {
      console.error('insight data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });
}

module.exports = { registerAdminInsightRoutes, normalizeDateRange, calendarDate, addDaysIso };

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function calendarDate(now, utcOffsetHours) {
  return new Date(Number(now) + utcOffsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDaysIso(iso, delta) {
  const d = new Date(iso + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isIsoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) === v;
}

function daysInclusive(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}

function normalizeDateRange(input, now = Date.now()) {
  const today = calendarDate(now, 8);
  const rawFrom = String(input.from || '').trim();
  const rawTo = String(input.to || '').trim();
  if (rawFrom || rawTo) {
    if (!rawFrom || !rawTo) throw new Error('請同時選擇開始日與結束日。');
    if (!isIsoDate(rawFrom) || !isIsoDate(rawTo)) throw new Error('日期格式不正確，請重新選擇。');
    if (rawFrom > rawTo) throw new Error('開始日不能晚於結束日。');
    if (rawTo > today) throw new Error('結束日不能晚於今天。');
    const days = daysInclusive(rawFrom, rawTo);
    if (days > MAX_EXACT_RANGE_DAYS) throw new Error('一次最多查詢 397 天，請縮短日期範圍。');
    return { from: rawFrom, to: rawTo, days, timezone: 'Asia/Taipei' };
  }
  const days = clampInt(input.days, 1, 365, 30);
  return { from: addDaysIso(today, -(days - 1)), to: today, days, timezone: 'Asia/Taipei' };
}

function compactDate(iso) {
  return String(iso || '').replace(/-/g, '');
}

function expandDate(v) {
  const s = String(v || '');
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) : null;
}

function emptyRichMenuInsight(range, reason, extra = {}) {
  return {
    available: false,
    reason,
    total_impressions: null,
    pages: [],
    requested_from: range.from,
    requested_to: range.to,
    metrics_from: null,
    metrics_to: null,
    partial: false,
    truncated: false,
    menu_pages_found: 0,
    ...extra
  };
}

function inferRichMenuReason(results) {
  if (results.some(x => x.status === 'privacy_limited')) return 'privacy_limited';
  if (results.some(x => x.status === 'not_ready')) return 'not_ready';
  if (results.some(x => x.status === 'rate_limited')) return 'rate_limited';
  if (results.every(x => x.status === 'deleted')) return 'deleted';
  return 'unavailable';
}
