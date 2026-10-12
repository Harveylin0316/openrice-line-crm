'use strict';
const { buildOutlookDraft, DRAFT_REASON } = require('../core/revisitOutlook');
function registerRevisitOutlook(app, { pool, requireOwner, originFor, jsonError, schemaError }) {
  app.post('/admin/revisit-email/api/recipients/:id(\\d+)/outlook-draft', requireOwner, async (req, res) => {
    if (req.body?.confirmed !== true) return jsonError(res, 400, 'draft_confirmation_required', '請先確認內容與收件人；只會開啟草稿，不會寄出。');
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('revisit_campaign_drafts'))");
      const found = await client.query(`SELECT r.*, c.status AS campaign_status FROM revisit_email_recipients r
        JOIN revisit_email_campaigns c ON c.id=r.campaign_id WHERE r.id=$1 FOR UPDATE OF c,r`, [Number(req.params.id)]);
      const row = found.rows[0];
      const reopen = row?.status === 'needs_review' && row.failure_detail === DRAFT_REASON;
      if (!row || !['draft','sending'].includes(row.campaign_status) || (!reopen && row.status !== 'pending')) {
        await client.query('ROLLBACK');
        return jsonError(res, 409, 'draft_not_available', '這封信已處理或批次已關閉，不能再開啟草稿。');
      }
      const blocked = await client.query(`SELECT EXISTS(SELECT 1 FROM admin_email_unsubscribes WHERE LOWER(email)=LOWER($1))
        OR EXISTS(SELECT 1 FROM revisit_email_suppressions WHERE active=TRUE AND email_normalized=LOWER($1))
        OR EXISTS(SELECT 1 FROM revisit_email_recipients WHERE booking_id=$2 AND id<>$3 AND status IN ('sent','sending','needs_review')) AS blocked`,
        [row.recipient_email, row.booking_id, row.id]);
      if (blocked.rows[0]?.blocked) {
        await client.query('ROLLBACK');
        return jsonError(res, 409, 'recipient_blocked', '這位客人已退訂、不可寄送，或同一筆訂位已處理。請不要寄出既有草稿。');
      }
      const draft = buildOutlookDraft(row, originFor(req));
      if (!reopen) {
        const settings = await client.query('SELECT daily_send_limit FROM revisit_email_settings WHERE id=1 FOR UPDATE');
        const usage = await client.query(`SELECT COUNT(*)::int AS count FROM revisit_email_recipients
          WHERE (status='sent' AND (sent_at AT TIME ZONE 'Asia/Taipei')::date=(NOW() AT TIME ZONE 'Asia/Taipei')::date)
          OR (status='sending' AND (updated_at AT TIME ZONE 'Asia/Taipei')::date=(NOW() AT TIME ZONE 'Asia/Taipei')::date)
          OR (status='needs_review' AND failure_detail=$1)`, [DRAFT_REASON]);
        if (!settings.rows[0] || Number(usage.rows[0]?.count) >= Number(settings.rows[0].daily_send_limit)) {
          await client.query('ROLLBACK');
          return jsonError(res, 409, 'daily_limit_reached', '寄送額度已用完，或尚有 Outlook 草稿待確認；請先整理寄件備份與未寄草稿。');
        }
        await client.query(`UPDATE revisit_email_recipients SET status='needs_review', failure_detail=$2, updated_at=NOW() WHERE id=$1`, [row.id, DRAFT_REASON]);
        await client.query(`UPDATE revisit_email_campaigns SET status='sending', started_at=COALESCE(started_at,NOW()) WHERE id=$1`, [row.campaign_id]);
        await client.query(`INSERT INTO revisit_email_recipient_events (recipient_id,campaign_id,event_type,detail,acted_by)
          VALUES ($1,$2,'outlook_draft_requested',$3::jsonb,$4)`, [row.id,row.campaign_id,JSON.stringify({ delivery: 'not_confirmed' }),req.authUser.un]);
      }
      await client.query('COMMIT');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok:true, draft, status:'needs_review', reopened:reopen });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (/^invalid_draft_/.test(err.message)) return jsonError(res, 400, err.message, '信件資料或連結不完整，請先修正草稿。');
      return schemaError(res, err);
    } finally { if (client) client.release(); }
  });
}
module.exports = { registerRevisitOutlook };
