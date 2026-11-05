// Keep LINE's deadline independent of Lambda cold start / PostgreSQL startup.
// Acknowledge only after Netlify accepts a durable background invocation.
export function createEdgeReceiver({ env, fetcher = fetch, cryptoApi = crypto, log = console.info }) {
  return async (request, context) => {
    const started = Date.now();
    const reply = status => new Response(status === 200 ? '{}' : '', { status,
      headers: { 'content-type':'application/json', 'cache-control':'no-store' } });
    if (request.method !== 'POST') return reply(405);
    const secret = env('LINE_CHANNEL_SECRET');
    const workerSecret = env('SCHEDULED_RUNNER_SECRET');
    if (!secret || !workerSecret) return reply(503);
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.length > 256 * 1024) return reply(413);
    const signed = request.headers.get('x-line-signature') || '';
    let sig;
    try { sig = Uint8Array.from(atob(signed), x => x.charCodeAt(0)); } catch { return reply(401); }
    const key = await cryptoApi.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if (!await cryptoApi.subtle.verify('HMAC',key,sig,raw)) return reply(401);
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply(400); }
    if (!Array.isArray(payload.events) || payload.events.length > 1000 || payload.events.some(e =>
      !e || typeof e.webhookEventId !== 'string' || !e.webhookEventId || e.webhookEventId.length > 200)) return reply(400);
    if (!payload.events.length) return reply(200);
    // Larger batches retain the previous DB-before-ack receiver, avoiding the
    // background invocation's 256KB envelope limit (base64 + Lambda headers).
    if (raw.length > 96 * 1024) return context.next(new Request(request,{body:raw}));
    const origin = new URL(request.url);
    const name = context.site?.name;
    if (!name || origin.protocol !== 'https:' || !(
      origin.hostname === `${name}.netlify.app` || origin.hostname.endsWith(`--${name}.netlify.app`))) return reply(503);
    try {
      const result = await fetcher(new URL('/.netlify/functions/line-webhook-worker-background',origin),{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',
          'x-scheduler-secret':workerSecret,'x-line-signature':signed},
        body:raw,signal:AbortSignal.timeout(1200)
      });
      // A lost/ambiguous acceptance returns failure. LINE redelivery is safe:
      // existing inbox event IDs prevent a second execution.
      const status = result.status === 202 ? 200 : 503;
      log(JSON.stringify({event:'line_webhook_edge_handoff',status,duration_ms:Date.now()-started,count:payload.events.length}));
      return reply(status);
    } catch {
      log(JSON.stringify({event:'line_webhook_edge_handoff',status:503,duration_ms:Date.now()-started}));
      return reply(503);
    }
  };
}
export default (request,context) => createEdgeReceiver({env:key=>Netlify.env.get(key)})(request,context);
