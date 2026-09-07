const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminLiffAnalyticsRoutes } = require('../src/routes/adminLiffAnalytics');
const { registerAdminAttributionRoutes } = require('../src/routes/adminAttribution');

function appStub(routes) {
  return {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post() {}, put() {}, delete() {}
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render() { return this; }
  };
}

async function run(routes, key, queryParams = {}) {
  const res = response();
  const req = { query: queryParams, authUser: { un: 'admin' } };
  for (const handler of routes[key]) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

const pass = (_req, _res, next) => next();

test('LIFF 報表接受 365 天，並以參數傳給資料庫', async () => {
  const routes = {};
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [{}], rowCount: 1 };
  };
  registerAdminLiffAnalyticsRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'GET /admin/liff/random-rice/api/funnel', { days: '365' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.days, 365);
  assert.equal(calls[0].params[0], '365');
});

test('LIFF 報表會把過大的期間收在 365 天內', async () => {
  const routes = {};
  const calls = [];
  const query = async (_sql, params) => {
    calls.push(params);
    return { rows: [], rowCount: 0 };
  };
  registerAdminLiffAnalyticsRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'GET /admin/liff/random-rice/api/trend', { days: '9999' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.days, 365);
  assert.equal(calls[0][0], 365);
});

test('群發歸因觀察期可超過原本 30 天', async () => {
  const routes = {};
  const calls = [];
  const query = async (_sql, params) => {
    calls.push(params);
    return { rows: [], rowCount: 0 };
  };
  registerAdminAttributionRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'GET /admin/attribution/api/system', { days: '90', limit: '20' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.days, 90);
  assert.equal(calls[0][1], '90');
});
