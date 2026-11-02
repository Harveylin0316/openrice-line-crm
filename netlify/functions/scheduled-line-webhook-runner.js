const {query,wake} = require('../../src/core/lineWebhookInboxRuntime');
async function runRescue() {
  if (!process.env.SCHEDULED_RUNNER_SECRET) return {statusCode:200,body:'{"skipped":"worker_not_configured"}'};
  const pending = await query("SELECT EXISTS(SELECT 1 FROM line_webhook_inbox WHERE status='pending') OR EXISTS(SELECT 1 FROM line_webhook_inbox WHERE status='processing' AND started_at < now()-interval '20 minutes') AS needed");
  if (!pending.rows[0]?.needed) return {statusCode:200,body:'{}'};
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
