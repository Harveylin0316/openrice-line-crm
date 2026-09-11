const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminRevisitEmailRoutes } = require('../src/routes/adminRevisitEmail');

function appStub(routes) {
  return {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; },
    delete(path, ...handlers) { routes['DELETE ' + path] = handlers; }
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
  assert.ok(routes['POST /admin/revisit-email/api/recipients/:id(\\d+)/review']);
  assert.ok(routes['DELETE /admin/revisit-email/api/suppressions/:id(\\d+)']);
});

test('正式寄送在目前草稿版本未成功測試時由後端擋下', async () => {
  let smtpCalls = 0;
  const client = {
    async query(sql) {
      if (/SELECT status, content_version/.test(sql)) {
        return { rowCount: 1, rows: [{ status: 'draft', content_version: 2, tested_version: 1, last_tested_at: new Date() }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const routes = register({
    localSendEnabled: true,
    smtpEmailProvider: {
      isConfigured: () => true,
      async sendEmail() { smtpCalls += 1; return { ok: true }; },
      getDefaultSender: () => ({ email: 'sender@example.com' })
    },
    pool: { connect: async () => client }
  });
  const result = await run(routes, 'POST /admin/revisit-email/api/campaigns/:id(\\d+)/send', {
    params: { id: '9' }, body: { limit: 5 }
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error, 'successful_test_required');
  assert.equal(smtpCalls, 0);
});

test('測試信使用正式 CTA、追蹤與安全退訂鏈路，成功後才核准同版本', async () => {
  const sqlCalls = [];
  let mail;
  const routes = register({
    localSendEnabled: true,
    publicBaseUrl: 'https://crm.example.com',
    smtpEmailProvider: {
      isConfigured: () => true,
      async sendEmail(options) { mail = options; return { ok: true, messageId: 'test-message-id' }; },
      getDefaultSender: () => ({ email: 'sender@example.com' })
    },
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (/SELECT r\.\*, c\.status AS campaign_status/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: 4, campaign_id: 2, status: 'pending', campaign_status: 'draft', content_version: 3,
          subject: '歡迎回來', preheader: '預覽', restaurant_name: '測試餐廳', recipient_name: 'Hen',
          body_copy: '回來吃飯吧', cta_url: 'https://tw.openrice.com/r/1', offer_snapshot: null
        }] };
      }
      if (/INSERT INTO revisit_email_test_deliveries/.test(sql)) return { rowCount: 1, rows: [{ id: 77 }] };
      return { rowCount: 1, rows: [] };
    }
  });
  const result = await run(routes, 'POST /admin/revisit-email/api/recipients/:id(\\d+)/test', {
    params: { id: '4' }, body: { test_email: 'hen@example.com' }
  });
  assert.equal(result.statusCode, 200);
  assert.match(mail.subject, /^\[測試\]/);
  assert.match(mail.html, /https:\/\/crm\.example\.com\/email\/revisit\/click\/[a-f0-9]{48}/);
  assert.match(mail.html, /https:\/\/crm\.example\.com\/email\/revisit\/unsubscribe\/[a-f0-9]{48}/);
  assert.match(mail.html, /email\/revisit\/open\/[a-f0-9]{48}\.gif/);
  assert.match(mail.headers['List-Unsubscribe'], /email\/revisit\/unsubscribe/);
  assert.ok(sqlCalls.some((call) => /SET tested_version=a\.content_version/.test(call.sql)));
});

test('需確認信件只能逐封處理，重新排入會留下稽核紀錄', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, campaign_id, status, failure_detail/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 42, campaign_id: 8, status: 'needs_review', failure_detail: 'smtp_timeout' }] };
      }
      if (/SELECT COUNT\(\*\)::int AS count/.test(sql)) return { rowCount: 1, rows: [{ count: 1 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const routes = register({ pool: { connect: async () => client } });
  const result = await run(routes, 'POST /admin/revisit-email/api/recipients/:id(\\d+)/review', {
    params: { id: '42' }, body: { action: 'retry' }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'pending');
  assert.ok(calls.some((call) => /UPDATE revisit_email_recipients SET status=\$2/.test(call.sql) && call.params[0] === 42 && call.params[1] === 'pending'));
  assert.ok(calls.some((call) => /INSERT INTO revisit_email_recipient_events/.test(call.sql) && call.params[2] === 'manual_retry'));

  const bulk = await run(routes, 'POST /admin/revisit-email/api/campaigns/:id(\\d+)/retry-review', { params: { id: '8' } });
  assert.equal(bulk.statusCode, 410);
  assert.equal(bulk.body.error, 'bulk_review_disabled');
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
