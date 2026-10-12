'use strict';
const crypto = require('node:crypto');
function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function signature(body, secret) { return crypto.createHmac('sha256', secret).update(body).digest('base64'); }

// Only acknowledge after the atomic insert succeeds. Duplicate deliveries never reset state.
function createReceiver({ query, channelSecret, wake = async () => {} }) {
  return async event => {
    if (event.httpMethod !== 'POST') return { statusCode:405, body:'' };
    if (!channelSecret) return { statusCode:503, body:'' };
    const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
    if (raw.length > 256 * 1024) return { statusCode:413, body:'' };
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
    if (!equal(signature(raw, channelSecret), headers['x-line-signature'])) return { statusCode:401, body:'' };
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return { statusCode:400, body:'' }; }
    if (!Array.isArray(payload.events) || payload.events.length > 1000 || payload.events.some(e => !e || typeof e.webhookEventId !== 'string' || !e.webhookEventId || e.webhookEventId.length > 200)) return { statusCode:400, body:'' };
    if (!payload.events.length) return { statusCode:200, body:'{}' };
    try {
      await query(`INSERT INTO line_webhook_inbox(event_id,payload)
        SELECT x->>'webhookEventId',jsonb_build_object('destination',$2::text,'events',jsonb_build_array(x))
        FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS items(x,ord)
        ORDER BY ord ON CONFLICT(event_id) DO NOTHING`, [JSON.stringify(payload.events), payload.destination || null]);
    } catch { console.error('line inbox persist failed'); return { statusCode:503, body:'' }; }
    // Wake failure is safe: the durable pending rows are picked up by the scheduled runner.
    try { await wake(); } catch { console.error('line inbox wake deferred'); }
    return { statusCode:200, body:'{}' };
  };
}

function createDrain({ query, processEvent, now = Date.now }) {
  return async ({ limit = 20, budgetMs = 45000 } = {}) => {
    const deadline = now() + budgetMs;
    let processed = 0;
    // A crashed/terminated in-flight task is ambiguous, not safe to send again.
    await query("UPDATE line_webhook_inbox SET status='uncertain',finished_at=now(),reason='worker_interrupted' WHERE status='processing' AND started_at < now()-interval '20 minutes'");
    while (processed < limit && now() < deadline) {
      const claimed = await query(`UPDATE line_webhook_inbox SET status='processing',started_at=now()
        WHERE event_id=(SELECT q.event_id FROM line_webhook_inbox q WHERE q.status='pending'
        AND NOT EXISTS(SELECT 1 FROM line_webhook_inbox active WHERE active.status='processing'
          AND COALESCE(active.payload#>>'{events,0,source,userId}',active.event_id)=COALESCE(q.payload#>>'{events,0,source,userId}',q.event_id))
        ORDER BY q.received_at,q.event_id FOR UPDATE OF q SKIP LOCKED LIMIT 1) AND status='pending'
        RETURNING event_id,payload`);
      const row = claimed.rows[0];
      if (!row) break;
      let status = 'done';
      try { if (!await processEvent(row.payload)) status = 'uncertain'; }
      catch { status = 'uncertain'; }
      await query('UPDATE line_webhook_inbox SET status=$2,finished_at=now(),reason=$3 WHERE event_id=$1 AND status=\'processing\'', [row.event_id,status,status === 'uncertain' ? 'handler_failed_no_blind_retry' : null]);
      if (status === 'uncertain') console.error('line inbox processing uncertain', row.event_id);
      processed++;
    }
    return { processed };
  };
}
module.exports = { equal, signature, createReceiver, createDrain };
