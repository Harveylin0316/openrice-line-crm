'use strict';

// Run the existing authenticated route in this invocation, not a second HTTP
// invocation. Do not retry ambiguous sends or bypass the route's own locks.
const ALLOWED_PATHS = new Set([
  '/admin/flows/run', '/admin/broadcast/run-scheduled',
  '/admin/richmenu/run-schedule', '/admin/users/run-tag-rules',
  '/admin/activities/run-schedule', '/admin/recipient-lists/run-dynamic'
]);
function createDispatch(loadHandler = () => require('../functions/server').handler, env = process.env) {
  return async (path, source) => {
    if (!ALLOWED_PATHS.has(path)) throw new Error('unsupported_scheduler_path');
    const base = env.URL || env.DEPLOY_URL;
    if (!base) return { statusCode: 500, body: '{"error":"missing_URL_env"}' };
    if (!env.SCHEDULED_RUNNER_SECRET) {
      return { statusCode: 200, body: '{"skipped":"no_SCHEDULED_RUNNER_SECRET"}' };
    }
    const origin = new URL(base);
    return loadHandler()({
      httpMethod: 'POST', path, rawUrl: new URL(path, origin).href,
      headers: {
        host: origin.host, 'x-forwarded-proto': origin.protocol.slice(0, -1),
        'content-type': 'application/json', 'x-scheduler-secret': env.SCHEDULED_RUNNER_SECRET
      },
      queryStringParameters: {}, multiValueQueryStringParameters: {},
      body: JSON.stringify({ source }), isBase64Encoded: false,
      requestContext: { identity: { sourceIp: '127.0.0.1' } }
    }, {});
  };
}
exports.createDispatch = createDispatch;
exports.dispatch = createDispatch();
