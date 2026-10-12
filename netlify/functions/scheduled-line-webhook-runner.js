const {query,wake} = require('../../src/core/lineWebhookInboxRuntime');
exports.handler = async () => {
  if (!process.env.SCHEDULED_RUNNER_SECRET) return {statusCode:200,body:'{"skipped":"worker_not_configured"}'};
  const pending = await query("SELECT EXISTS(SELECT 1 FROM line_webhook_inbox WHERE status='pending') OR EXISTS(SELECT 1 FROM line_webhook_inbox WHERE status='processing' AND started_at < now()-interval '20 minutes') AS needed");
  if (!pending.rows[0]?.needed) return {statusCode:200,body:'{}'};
  await wake(3000);
  return {statusCode:200,body:'{}'};
};
