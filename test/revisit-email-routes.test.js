const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminRevisitEmailRoutes } = require('../src/routes/adminRevisitEmail');

function appStub(routes) {
  return {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; }
  };
}

function response() {
  return {
    statusCode: 200, body: null, view: null, locals: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render(view, locals) { this.view = view; this.locals = locals; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    type() { return this; }, send(body) { this.body = body; return this; },
    redirect(target) { this.statusCode = 302; this.redirectTo = target; return this; }
  };
}

async function run(routes, key, req = {}) {
  const res = response();
  const request = { body: {}, params: {}, authUser: { un: 'admin', adm: true, role: 'admin' }, ...req };
  for (const handler of routes[key]) {
    let next = false;
    await handler(request, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

const pass = (_req, _res, next) => next();

function register(overrides = {}) {
  const routes = {};
  registerAdminRevisitEmailRoutes(appStub(routes), {
    query: async () => ({ rows: [], rowCount: 0 }),
    pool: { connect: async () => { throw new Error('pool should not be used'); } },
    authCore: { requireAdmin: pass, requireOwner: pass, roleOf: () => 'admin' },
    smtpEmailProvider: { isConfigured: () => false, getDefaultSender: () => null },
    resolvePublicSiteOrigin: () => '', publicBaseUrl: '', localSendEnabled: false,
    ...overrides
  });
  return routes;
}

test('後台頁面與所有公開追蹤路徑都有註冊', async () => {
  const routes = register();
  const page = await run(routes, 'GET /admin/revisit-email');
  assert.equal(page.view, 'admin_revisit_email');
  assert.equal(page.locals.isOwner, true);
  assert.ok(routes['GET /email/revisit/open/:token([a-f0-9]{48}).gif']);
  assert.ok(routes['GET /email/revisit/click/:token([a-f0-9]{48})']);
  assert.ok(routes['POST /email/revisit/unsubscribe/:token([a-f0-9]{48})']);
});

test('正式環境未開本機旗標時，測試信與正式寄送都在查資料前擋下', async () => {
  const routes = register();
  const testMail = await run(routes, 'POST /admin/revisit-email/api/recipients/:id(\\d+)/test', {
    params: { id: '1' }, body: { test_email: 'hen@example.com' }
  });
  assert.equal(testMail.statusCode, 403);
  assert.equal(testMail.body.error, 'local_send_disabled');

  const send = await run(routes, 'POST /admin/revisit-email/api/campaigns/:id(\\d+)/send', {
    params: { id: '1' }, body: { limit: 20 }
  });
  assert.equal(send.statusCode, 403);
  assert.equal(send.body.error, 'local_send_disabled');
});

test('沒有正式 HTTPS 追蹤網址時不可產生草稿', async () => {
  const routes = register();
  const result = await run(routes, 'POST /admin/revisit-email/api/generate', {
    body: { as_of_date: '2026-09-10' }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'public_url_required');
});

test('不允許用未來日期提前產生回訪信', async () => {
  const routes = register({ publicBaseUrl: 'https://crm.example.com' });
  const result = await run(routes, 'POST /admin/revisit-email/api/generate', {
    body: { as_of_date: '2099-01-01' }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'future_as_of_date');
});
