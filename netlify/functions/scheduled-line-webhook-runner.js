const {query,wake} = require('../../src/core/lineWebhookInboxRuntime');
async function runRescue() {
  if (!process.env.SCHEDULED_RUNNER_SECRET) return {statusCode:200,body:'{"skipped":"worker_not_configured"}'};
  const pending = await query(`SELECT
    (SELECT GREATEST(0,EXTRACT(EPOCH FROM now()-received_at))::int
     FROM line_webhook_inbox WHERE status='pending' ORDER BY received_at,event_id LIMIT 1) AS oldest_pending_seconds,
    EXISTS(SELECT 1 FROM line_webhook_inbox WHERE status='processing'
      AND started_at < now()-interval '20 minutes') AS interrupted`);
  const state = pending.rows[0];
  if (!state || (state.oldest_pending_seconds == null && !state.interrupted)) return {statusCode:200,body:'{}'};
  // Only indexed oldest-row/EXISTS reads; no full inbox count or customer data.
  if (state.oldest_pending_seconds >= 30 || state.interrupted) console.warn(JSON.stringify({
    event:'line_webhook_queue_delayed',oldest_pending_seconds:state.oldest_pending_seconds,
    interrupted:state.interrupted }));
  await wake(3000);
  return {statusCode:200,body:'{}'};
}
exports.runRescue = runRescue;
// No standalone cron anymore. If this compatibility endpoint is invoked over
// HTTP it must not become a public unauthenticated way to wake the worker.
exports.handler = async (event = {}) => {
  const expected = process.env.SCHEDULED_RUNNER_SECRET;
  const provided = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-scheduler-secret')?.[1];
  if (!expected || provided !== expected) return { statusCode: 403, body: '{"error":"forbidden"}' };
  return runRescue();
};
