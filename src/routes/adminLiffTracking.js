/**
 * 通用 LIFF 來源追蹤。
 *
 * 管理員建立一條「活動／來源／目的地」設定後，系統產生 LIFF 追蹤網址。
 * 用戶打開時先由 LINE ID token 驗證身分、記錄一次開啟，再前往原目的地。
 * 追蹤失敗或設定暫停都不能阻擋使用者前往目的地。
 */
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');

const SOURCE_PRESETS = [
  ['richmenu', '圖文選單'],
  ['broadcast', '群發訊息'],
  ['welcome', '歡迎訊息'],
  ['qr', 'QR Code'],
  ['facebook', 'Facebook'],
  ['instagram', 'Instagram'],
  ['share', '好友分享'],
  ['other', '其他']
];
const CONVERSION_TYPES = new Set(['none', 'activity_play', 'user_event']);
const EVENT_LABELS = {
  app_open: '開啟活動頁', map_booking_click: '按下訂位', map_restaurant_view: '查看餐廳',
  map_share_click: '分享內容', map_favorite_toggle: '收藏餐廳', map_decide_click: '使用幫我決定',
  map_decide_result: '看到決定結果', map_search: '搜尋餐廳'
};

function cleanHttpsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function cleanSourceKey(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value) ? value : '';
}

function reportDays(raw) {
  if (String(raw || '').toLowerCase() === 'all') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(365, value));
}

function conversionLabel(row, activities, events) {
  if (row.conversion_type === 'activity_play') {
    const activity = activities.find(a => String(a.id) === String(row.conversion_key));
    return activity ? `玩過「${activity.name}」` : `玩過活動 #${row.conversion_key}`;
  }
  if (row.conversion_type === 'user_event') {
    const event = events.find(e => e.event_name === row.conversion_key);
    return event ? event.label : `完成 ${row.conversion_key}`;
  }
  return '只看開啟';
}

function registerAdminLiffTrackingRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;
  const verifyToken = deps.verifyLiffIdToken || verifyLiffIdToken;

  function trackingLiffId() {
    return String(process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '').trim();
  }
  function siteBase() {
    return String(process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');
  }
  function trackingUrl(id) {
    const liffId = trackingLiffId();
    return liffId ? `https://liff.line.me/${liffId}/lt/${id}` : '';
  }
  function browserTarget(rawTarget) {
    const target = cleanHttpsUrl(rawTarget);
    const liffId = trackingLiffId();
    const base = siteBase();
    if (!target || !liffId || !base) return target;
    const match = /^https:\/\/liff\.line\.me\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(target);
    if (match && match[1] === liffId) {
      return base + '/games' + (match[2] || '') + (match[3] || '') + (match[4] || '');
    }
    return target;
  }
  function jsonErr(res, status, error, detail) {
    return res.status(status).json({ ok: false, error, detail });
  }

  app.get('/admin/liff-tracking', requireAdmin, (req, res) => {
    res.render('admin_liff_tracking', {
      title: 'LIFF 來源追蹤',
      bodyClass: 'admin-shell liff-tracking-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      sourcePresets: SOURCE_PRESETS.map(([value, label]) => ({ value, label }))
    });
  });

  app.get('/admin/liff-tracking/api/options', requireAdmin, async (_req, res) => {
    try {
      const [activityRows, eventRows] = await Promise.all([
        query(`SELECT id, name, slug, game_type, liff_id_override FROM activities ORDER BY id DESC LIMIT 100`),
        query(`SELECT event_name, COUNT(*)::int AS count
                 FROM user_events
                WHERE event_name IS NOT NULL AND created_at >= now() - interval '180 days'
                GROUP BY event_name ORDER BY count DESC, event_name ASC LIMIT 100`)
      ]);
      const events = eventRows.rows.map(row => ({
        event_name: row.event_name,
        count: Number(row.count || 0),
        label: EVENT_LABELS[row.event_name] || row.event_name
      }));
      const activities = activityRows.rows.map(row => {
        const liffId = String(row.liff_id_override || trackingLiffId() || '').trim();
        return {
          ...row,
          liff_url: liffId && row.game_type && row.slug
            ? `https://liff.line.me/${liffId}/${row.game_type}/${row.slug}` : ''
        };
      });
      res.json({
        ok: true,
        tracking_available: !!trackingLiffId(),
        sources: SOURCE_PRESETS.map(([value, label]) => ({ value, label })),
        activities,
        events
      });
    } catch (err) {
      console.error('liff tracking options error:', err && err.message);
      jsonErr(res, 500, 'options_failed', '載入選項失敗，請重新整理再試。');
    }
  });

  app.get('/admin/liff-tracking/api/data', requireAdmin, async (req, res) => {
    try {
      const days = reportDays(req.query.days);
      const params = days == null ? [] : [String(days)];
      const eventRange = days == null ? '' : ` AND e.opened_at >= now() - ($1::text || ' days')::interval`;
      const openRange = days == null ? '' : ` WHERE opened_at >= now() - ($1::text || ' days')::interval`;

      const [linksResult, activitiesResult, eventsResult, summaryResult, sourceResult, dailyResult] = await Promise.all([
        query(`SELECT l.id, l.name, l.campaign_name, l.source_key, l.source_label, l.target_url,
                      l.conversion_type, l.conversion_key, l.attribution_days, l.status,
                      l.created_at, l.updated_at,
                      COUNT(e.id)::int AS opens,
                      COUNT(DISTINCT e.line_user_id)::int AS unique_users,
                      MAX(e.opened_at) AS last_opened_at
                 FROM liff_tracking_links l
                 LEFT JOIN liff_tracking_events e ON e.tracking_link_id = l.id${eventRange}
                GROUP BY l.id ORDER BY l.created_at DESC LIMIT 200`, params),
        query(`SELECT id, name, slug FROM activities ORDER BY id DESC LIMIT 100`),
        query(`SELECT event_name, COUNT(*)::int AS count FROM user_events
                WHERE event_name IS NOT NULL AND created_at >= now() - interval '180 days'
                GROUP BY event_name ORDER BY count DESC LIMIT 100`),
        query(`SELECT COUNT(*)::int AS opens, COUNT(DISTINCT line_user_id)::int AS unique_users,
                      (SELECT COUNT(*)::int FROM liff_tracking_links WHERE status='active') AS active_links
                 FROM liff_tracking_events${openRange}`, params),
        query(`SELECT l.source_key, l.source_label, COUNT(e.id)::int AS opens,
                      COUNT(DISTINCT e.line_user_id)::int AS unique_users
                 FROM liff_tracking_links l
                 LEFT JOIN liff_tracking_events e ON e.tracking_link_id=l.id${eventRange}
                GROUP BY l.source_key, l.source_label ORDER BY opens DESC, l.source_label ASC`, params),
        query(`SELECT to_char(date_trunc('day', opened_at AT TIME ZONE 'Asia/Taipei'), 'YYYY-MM-DD') AS day,
                      COUNT(*)::int AS opens, COUNT(DISTINCT line_user_id)::int AS unique_users
                 FROM liff_tracking_events${openRange}
                GROUP BY date_trunc('day', opened_at AT TIME ZONE 'Asia/Taipei')
                ORDER BY date_trunc('day', opened_at AT TIME ZONE 'Asia/Taipei') ASC`, params)
      ]);

      const conversionParams = params;
      const firstOpenRange = days == null ? '' : ` WHERE e.opened_at >= now() - ($1::text || ' days')::interval`;
      const [activityConversionResult, eventConversionResult] = await Promise.all([
        query(`WITH first_open AS (
                 SELECT e.tracking_link_id, e.line_user_id, MIN(e.opened_at) AS first_opened_at
                   FROM liff_tracking_events e${firstOpenRange}
                  GROUP BY e.tracking_link_id, e.line_user_id
               )
               SELECT l.id, COUNT(*)::int AS conversions
                 FROM liff_tracking_links l
                 JOIN first_open f ON f.tracking_link_id=l.id
                WHERE l.conversion_type='activity_play' AND l.conversion_key ~ '^[0-9]+$'
                  AND EXISTS (
                    SELECT 1 FROM activity_plays p
                     WHERE p.line_user_id=f.line_user_id
                       AND p.activity_id=l.conversion_key::bigint
                       AND p.played_at >= f.first_opened_at
                       AND p.played_at <= f.first_opened_at + make_interval(days => l.attribution_days)
                  )
                GROUP BY l.id`, conversionParams),
        query(`WITH first_open AS (
                 SELECT e.tracking_link_id, e.line_user_id, MIN(e.opened_at) AS first_opened_at
                   FROM liff_tracking_events e${firstOpenRange}
                  GROUP BY e.tracking_link_id, e.line_user_id
               )
               SELECT l.id, COUNT(*)::int AS conversions
                 FROM liff_tracking_links l
                 JOIN first_open f ON f.tracking_link_id=l.id
                WHERE l.conversion_type='user_event'
                  AND EXISTS (
                    SELECT 1 FROM user_events ue
                     WHERE ue.event_name=l.conversion_key
                       AND ue.created_at >= f.first_opened_at
                       AND ue.created_at <= f.first_opened_at + make_interval(days => l.attribution_days)
                       AND (
                         ue.line_id=f.line_user_id
                         OR EXISTS (
                           SELECT 1 FROM users u
                            WHERE u.line_user_id=f.line_user_id AND u.line_id_hash=ue.line_id
                         )
                       )
                  )
                GROUP BY l.id`, conversionParams)
      ]);

      const conversionMap = new Map();
      [...activityConversionResult.rows, ...eventConversionResult.rows].forEach(row => {
        conversionMap.set(Number(row.id), Number(row.conversions || 0));
      });
      const eventCatalog = eventsResult.rows.map(row => ({
        event_name: row.event_name,
        label: EVENT_LABELS[row.event_name] || row.event_name
      }));
      const links = linksResult.rows.map(row => {
        const uniqueUsers = Number(row.unique_users || 0);
        const conversions = conversionMap.get(Number(row.id)) || 0;
        return {
          ...row,
          id: Number(row.id),
          opens: Number(row.opens || 0),
          unique_users: uniqueUsers,
          conversions,
          conversion_rate_pct: uniqueUsers ? Math.round((conversions / uniqueUsers) * 10000) / 100 : 0,
          conversion_label: conversionLabel(row, activitiesResult.rows, eventCatalog),
          tracking_url: trackingUrl(row.id)
        };
      });
      const summary = summaryResult.rows[0] || {};
      res.json({
        ok: true,
        days,
        timezone: 'Asia/Taipei',
        tracking_available: !!trackingLiffId(),
        summary: {
          opens: Number(summary.opens || 0),
          unique_users: Number(summary.unique_users || 0),
          active_links: Number(summary.active_links || 0),
          conversions: links.reduce((sum, link) => sum + link.conversions, 0)
        },
        sources: sourceResult.rows.map(row => ({
          ...row, opens: Number(row.opens || 0), unique_users: Number(row.unique_users || 0)
        })),
        daily: dailyResult.rows.map(row => ({
          ...row, opens: Number(row.opens || 0), unique_users: Number(row.unique_users || 0)
        })),
        links
      });
    } catch (err) {
      console.error('liff tracking data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', '讀取 LIFF 成效失敗，請稍後再試。');
    }
  });

  app.post('/admin/liff-tracking/api/links', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 100);
      const campaignName = String(body.campaign_name || '').trim().slice(0, 100);
      const sourceKey = cleanSourceKey(body.source_key);
      const sourceLabel = String(body.source_label || '').trim().slice(0, 60);
      const targetUrl = cleanHttpsUrl(body.target_url);
      const conversionType = String(body.conversion_type || 'none');
      const attributionDays = Math.round(Number(body.attribution_days || 7));
      let conversionKey = conversionType === 'none' ? null : String(body.conversion_key || '').trim().slice(0, 100);

      if (!trackingLiffId()) return jsonErr(res, 503, 'liff_not_configured', '尚未設定通用 LIFF ID，請聯絡管理員。');
      if (!name) return jsonErr(res, 400, 'name_required', '請填追蹤名稱。');
      if (!campaignName) return jsonErr(res, 400, 'campaign_required', '請填 Campaign 名稱。');
      if (!sourceKey || !sourceLabel) return jsonErr(res, 400, 'source_invalid', '來源代號或名稱不正確。');
      if (!targetUrl) return jsonErr(res, 400, 'target_invalid', '目的地必須是完整的 HTTPS 網址。');
      if (!CONVERSION_TYPES.has(conversionType)) return jsonErr(res, 400, 'conversion_invalid', '轉換目標不正確。');
      if (!Number.isFinite(attributionDays) || attributionDays < 1 || attributionDays > 365) {
        return jsonErr(res, 400, 'days_invalid', '轉換觀察期請填 1 到 365 天。');
      }
      if (conversionType !== 'none' && !conversionKey) {
        return jsonErr(res, 400, 'conversion_key_required', '請選擇要觀察的轉換行為。');
      }
      if (conversionType === 'activity_play') {
        if (!/^\d+$/.test(conversionKey)) return jsonErr(res, 400, 'activity_invalid', '活動編號不正確。');
        const activity = await query(`SELECT id FROM activities WHERE id=$1 LIMIT 1`, [Number(conversionKey)]);
        if (!activity.rowCount) return jsonErr(res, 400, 'activity_invalid', '找不到這個活動。');
      }
      if (conversionType === 'user_event') {
        if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(conversionKey)) {
          return jsonErr(res, 400, 'event_invalid', '事件代號不正確。');
        }
        const event = await query(`SELECT 1 FROM user_events WHERE event_name=$1 LIMIT 1`, [conversionKey]);
        if (!event.rowCount) return jsonErr(res, 400, 'event_invalid', '目前沒有這個事件，請重新整理選項。');
      }

      const createdBy = (req.authUser && req.authUser.un) || 'admin';
      const result = await query(
        `INSERT INTO liff_tracking_links
           (name, campaign_name, source_key, source_label, target_url,
            conversion_type, conversion_key, attribution_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [name, campaignName, sourceKey, sourceLabel, targetUrl,
         conversionType, conversionKey, attributionDays, createdBy]
      );
      const id = Number(result.rows[0].id);
      res.status(201).json({ ok: true, id, tracking_url: trackingUrl(id) });
    } catch (err) {
      console.error('liff tracking create error:', err && err.message);
      jsonErr(res, 500, 'create_failed', '建立追蹤網址失敗，請稍後再試。');
    }
  });

  app.post('/admin/liff-tracking/api/links/:id(\\d+)/status', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const status = String((req.body || {}).status || '');
      if (!id || !['active', 'paused'].includes(status)) {
        return jsonErr(res, 400, 'status_invalid', '狀態不正確。');
      }
      const result = await query(
        `UPDATE liff_tracking_links SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, status`,
        [id, status]
      );
      if (!result.rowCount) return jsonErr(res, 404, 'not_found', '找不到這條追蹤網址。');
      res.json({ ok: true, link: result.rows[0] });
    } catch (err) {
      console.error('liff tracking status error:', err && err.message);
      jsonErr(res, 500, 'status_failed', '更新狀態失敗，請稍後再試。');
    }
  });

  const bouncePaths = ['/lt/:id(\\d+)', '/games/lt/:id(\\d+)'];
  bouncePaths.forEach(path => app.get(path, async (req, res) => {
    const fallback = 'https://www.openrice.com';
    try {
      const id = Number(req.params.id);
      const result = await query(`SELECT id, target_url FROM liff_tracking_links WHERE id=$1 LIMIT 1`, [id]);
      const row = result.rows[0];
      const target = row && cleanHttpsUrl(row.target_url);
      if (!target) return res.redirect(302, fallback);
      res.setHeader('Cache-Control', 'no-store');
      return res.render('tap_bounce', {
        target: browserTarget(target),
        liffId: trackingLiffId(),
        recordUrl: `/lt/${id}/hit`
      });
    } catch (err) {
      console.error('liff tracking bounce error:', err && err.message);
      return res.redirect(302, fallback);
    }
  }));

  const hitPaths = ['/lt/:id(\\d+)/hit', '/games/lt/:id(\\d+)/hit'];
  hitPaths.forEach(path => app.post(path, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const linkResult = await query(`SELECT id, status FROM liff_tracking_links WHERE id=$1 LIMIT 1`, [id]);
      const link = linkResult.rows[0];
      if (!link || link.status !== 'active') return res.json({ ok: true, skipped: true });
      const liffId = trackingLiffId();
      if (!liffId) return res.json({ ok: true, skipped: true });
      const idToken = String((req.body || {}).id_token || '').trim();
      const verified = await verifyToken(idToken, channelIdFromLiffId(liffId));
      const uid = verified && verified.ok && /^U[0-9a-f]{32}$/i.test(String(verified.sub || ''))
        ? String(verified.sub) : null;
      if (!uid) return res.status(401).json({ ok: false, error: 'identity_verification_failed' });

      const inserted = await query(
        `INSERT INTO liff_tracking_events (tracking_link_id, line_user_id, dedupe_minute)
         VALUES ($1,$2,date_trunc('minute', now()))
         ON CONFLICT (tracking_link_id, line_user_id, dedupe_minute) DO NOTHING
         RETURNING id`,
        [id, uid]
      );
      res.json({ ok: true, recorded: inserted.rowCount > 0, deduped: inserted.rowCount === 0 });
    } catch (err) {
      console.error('liff tracking hit error:', err && err.message);
      // 記錄失敗不能卡住 tap_bounce 的導向。
      res.json({ ok: true, recorded: false });
    }
  }));
}

module.exports = {
  registerAdminLiffTrackingRoutes,
  cleanHttpsUrl,
  cleanSourceKey,
  reportDays,
  SOURCE_PRESETS
};
