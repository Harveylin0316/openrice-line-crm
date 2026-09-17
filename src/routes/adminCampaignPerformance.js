'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRange(q, now = new Date()) {
  const toDefault = now.toISOString().slice(0, 10);
  const fromDefault = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const from = String(q.from || fromDefault);
  const to = String(q.to || toDefault);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new Error('日期範圍錯誤');
  return { from, to };
}

function campaignName(row) {
  const cfg = row.message_config || {};
  const template = cfg.template || cfg;
  return String(row.email_subject || template.title || template.altText || `群發 #${row.id}`).slice(0, 100);
}

function registerAdminCampaignPerformanceRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin/campaign-performance', requireAdmin, (req, res) => {
    res.render('admin_campaign_performance', {
      title: '群發成效', bodyClass: 'admin-shell',
      user: (req.authUser && req.authUser.un) || '', isAdmin: true
    });
  });

  app.get('/admin/campaign-performance/api', requireAdmin, async (req, res) => {
    let range;
    try { range = normalizeRange(req.query || {}); }
    catch (err) { return res.status(400).json({ ok: false, error: 'bad_range', detail: err.message }); }
    try {
      const rows = (await query(
        `WITH selected AS (
           SELECT b.* FROM admin_broadcasts b
            WHERE (b.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
              AND b.status NOT IN ('draft','cancelled')
            ORDER BY b.id DESC LIMIT 100
         ), recipient_stats AS (
           SELECT r.broadcast_id,
             COUNT(*)::int AS materialized,
             COUNT(*) FILTER (WHERE r.status='sent')::int AS sent,
             COUNT(*) FILTER (WHERE r.delivered_at IS NOT NULL)::int AS delivered,
             COUNT(*) FILTER (WHERE r.opened_at IS NOT NULL)::int AS opened,
             COUNT(*) FILTER (WHERE r.first_clicked_at IS NOT NULL)::int AS clicked,
             COUNT(*) FILTER (WHERE r.status='failed')::int AS failed
           FROM admin_broadcast_recipients r JOIN selected b ON b.id=r.broadcast_id
           GROUP BY r.broadcast_id
         ), downstream AS (
           SELECT b.id AS broadcast_id,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM member_liff_events le JOIN users lu ON lu.id=le.user_id
                WHERE lu.line_user_id=r.line_user_id AND le.created_at>=COALESCE(r.pushed_at,b.created_at)
                  AND le.created_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS liff,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM campaign_phone_registrations pr
                WHERE pr.line_user_id=r.line_user_id AND pr.registered_at>=COALESCE(r.pushed_at,b.created_at)
                  AND pr.registered_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS registrations,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM gold_pig_bookings gb
                WHERE gb.line_user_id=r.line_user_id
                  AND gb.created_at>=COALESCE(r.pushed_at,b.created_at)
                  AND gb.created_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS bookings,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM gold_pig_bookings gb
                WHERE gb.line_user_id=r.line_user_id AND gb.status='confirmed'
                  AND gb.created_at>=COALESCE(r.pushed_at,b.created_at)
                  AND gb.created_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS booking_confirmed,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM gold_pig_bookings gb
                WHERE gb.line_user_id=r.line_user_id AND gb.status IN ('cancellation_requested','cancelled')
                  AND gb.created_at>=COALESCE(r.pushed_at,b.created_at)
                  AND gb.created_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS booking_cancelled,
             COUNT(DISTINCT r.line_user_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM line_webhook_events we
                WHERE we.line_user_id=r.line_user_id AND we.event_type='unfollow'
                  AND we.created_at>=COALESCE(r.pushed_at,b.created_at)
                  AND we.created_at<COALESCE(r.pushed_at,b.created_at)+interval '7 days'))::int AS blocks
           FROM selected b JOIN admin_broadcast_recipients r ON r.broadcast_id=b.id
           WHERE r.status='sent'
           GROUP BY b.id,b.created_at
         )
         SELECT b.id,b.created_at,b.status,b.channel,b.recipient_total,b.audience_config,b.message_config,
                b.email_subject,b.is_ab_test,
                COALESCE(s.materialized,0)::int AS materialized,COALESCE(s.sent,0)::int AS sent,
                COALESCE(s.delivered,0)::int AS delivered,COALESCE(s.opened,0)::int AS opened,
                COALESCE(s.clicked,0)::int AS clicked,COALESCE(s.failed,0)::int AS failed,
                COALESCE(d.liff,0)::int AS liff,COALESCE(d.registrations,0)::int AS registrations,
                COALESCE(d.bookings,0)::int AS bookings,
                COALESCE(d.booking_confirmed,0)::int AS booking_confirmed,
                COALESCE(d.booking_cancelled,0)::int AS booking_cancelled,
                COALESCE(d.blocks,0)::int AS blocks
           FROM selected b LEFT JOIN recipient_stats s ON s.broadcast_id=b.id
           LEFT JOIN downstream d ON d.broadcast_id=b.id ORDER BY b.id DESC`, [range.from, range.to])).rows;

      const variants = (await query(
        `SELECT r.broadcast_id,r.variant,
                COUNT(*)::int AS target,
                COUNT(*) FILTER (WHERE r.status='sent')::int AS sent,
                COUNT(*) FILTER (WHERE r.opened_at IS NOT NULL)::int AS opened,
                COUNT(*) FILTER (WHERE r.first_clicked_at IS NOT NULL)::int AS clicked
           FROM admin_broadcast_recipients r JOIN admin_broadcasts b ON b.id=r.broadcast_id
          WHERE (b.created_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
            AND (b.is_ab_test = true OR COALESCE((b.audience_config->'experiment'->>'enabled')::boolean, false) = true)
          GROUP BY r.broadcast_id,r.variant ORDER BY r.broadcast_id DESC,r.variant`, [range.from, range.to])).rows;

      return res.json({ ok: true, range,
        campaigns: rows.map(r => ({ ...r, name: campaignName(r),
          delivered: r.channel === 'email' ? Number(r.delivered) : null,
          attendance: null,
          delivery_rate: r.channel === 'email' && Number(r.sent) ? Number(r.delivered) / Number(r.sent) : null,
          open_rate: Number(r.sent) ? Number(r.opened) / Number(r.sent) : null,
          ctr: Number(r.sent) ? Number(r.clicked) / Number(r.sent) : null,
          conversion_rate: Number(r.sent) ? Number(r.bookings) / Number(r.sent) : null,
          block_rate: Number(r.sent) ? Number(r.blocks) / Number(r.sent) : null
        })), variants,
        definitions: {
          window: '推播後 7 天',
          delivered: 'Email 以服務商 delivery webhook；LINE 不提供逐人送達資料',
          open: 'Email 開信像素／provider webhook；LINE 僅計有追蹤圖載入的開啟 proxy',
          registration: 'Registration 目前只計活動手機登記；OpenRice App Registration 尚未接入 LINE 身份橋接',
          booking: '目前只計已綁 LINE ID 的金豬食堂訂位；一般 Booking 尚未建立身份橋接',
          booking_status: 'Booking 包含之後取消者；Confirmed 與 Cancel 另列，方便檢查名單品質',
          attendance: '目前沒有可與 LINE ID 對應的到店資料，因此不顯示假數字'
        }
      });
    } catch (err) {
      console.error('campaign performance failed:', err && err.message);
      return res.status(500).json({ ok: false, error: 'data_failed', detail: err && err.message });
    }
  });
}

module.exports = { registerAdminCampaignPerformanceRoutes, normalizeRange, campaignName };
