'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

function register(query) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((out, method) => {
    out[method] = (path, ...handlers) => { routes[method.toUpperCase() + ' ' + path] = handlers; };
    return out;
  }, {});
  registerAdminBroadcastRoutes(app, {
    query,
    pool: { connect: async () => { throw new Error('unexpected pool use'); } },
    authCore: { requireAdmin: (_req, _res, next) => next() },
    linePush: null,
    emailProvider: null,
    lineChannelAccessToken: '',
    resolvePublicSiteOrigin: () => 'https://crm.example'
  });
  return routes;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    send(body) { this.body = body; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; }
  };
}

test('LINE 追蹤圖片同時寫入事件並更新收件人的 opened_at', async () => {
  const sqlCalls = [];
  const routes = register(async (sql) => {
    const text = String(sql).replace(/\s+/g, ' ');
    sqlCalls.push(text);
    if (/SELECT mime_type, body FROM line_push_media/.test(text)) {
      return { rowCount: 1, rows: [{ mime_type: 'image/png', body: Buffer.from('png') }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const key = 'GET /v/b/:broadcastId(\\d+)/:recipientId(\\d+)/:mediaId([0-9a-fA-F-]{36})';
  const req = {
    params: { broadcastId: '12', recipientId: '34', mediaId: '12345678-1234-1234-1234-123456789abc' },
    query: { v: 'a' },
    get: (name) => name === 'user-agent' ? 'LINE/1.0' : ''
  };
  const res = response();
  await routes[key][0](req, res);
  assert.equal(res.statusCode, 200);
  assert.match(sqlCalls[1], /INSERT INTO admin_broadcast_views/);
  assert.match(sqlCalls[1], /SET opened_at = COALESCE\(opened_at, NOW\(\)\)/);
});

test('LINE CTA 點擊同時寫入事件並更新收件人的 first_clicked_at', async () => {
  const sqlCalls = [];
  const routes = register(async (sql) => {
    const text = String(sql).replace(/\s+/g, ' ');
    sqlCalls.push(text);
    if (/SELECT message_config, variant_b_message_config/.test(text)) {
      return {
        rowCount: 1,
        rows: [{ message_config: { mode: 'template', template: { ctaUrl: 'https://example.com/offer' } } }]
      };
    }
    if (/SELECT line_user_id FROM admin_broadcast_recipients/.test(text)) return { rowCount: 1, rows: [{ line_user_id: null }] };
    return { rowCount: 1, rows: [] };
  });
  const key = 'GET /r/b/:broadcastId(\\d+)/:recipientId(\\d+)';
  const req = {
    params: { broadcastId: '12', recipientId: '34' },
    query: { v: 'a' },
    get: () => ''
  };
  const res = response();
  await routes[key][0](req, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.redirectUrl, 'https://example.com/offer');
  assert.match(sqlCalls[1], /INSERT INTO admin_broadcast_clicks/);
  assert.match(sqlCalls[1], /SET first_clicked_at = COALESCE\(first_clicked_at, NOW\(\)\)/);
});
