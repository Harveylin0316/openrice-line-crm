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
  assert.ok(routes['POST /admin/revisit-email/api/booking-report/sync']);
});

test('從訂位成效報表同步時會轉換狀態、批次寫入且不重複新增', async () => {
  const sqlCalls = [];
  const client = {
    async query(sql, params) {
      sqlCalls.push({ sql, params });
      if (/SELECT id, kind, source_file, status, received_count/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: 55, kind: 'bookings', source_file: '訂位成效報表 2026-09-01～2026-09-21',
          status: 'uploading', received_count: 0, accepted_count: 0, rejected_count: 0, uploaded_by: 'admin'
        }] };
      }
      if (/UPDATE revisit_email_imports SET/.test(sql)) {
        return { rowCount: 1, rows: [{ received_count: 1, accepted_count: 1, rejected_count: 0 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const routes = register({
    bookingReportClient: {
      isConfigured: () => true,
      async fetchPage() {
        return { total: 1, rows: [{
          booking_ref_id: 'BK-100', or_restaurant_id: 'OR-9', restaurant_name: '測試餐廳',
          status: 'Confirm', booking_date: '2026-09-01', diner_name_full: '王小明',
          email_full: 'Guest@Example.com'
        }] };
      }
    },
    query: async (sql) => {
      if (/INSERT INTO revisit_email_imports/.test(sql)) return { rowCount: 1, rows: [{ id: 55 }] };
      return { rowCount: 1, rows: [] };
    },
    pool: { connect: async () => client }
  });
  const result = await run(routes, 'POST /admin/revisit-email/api/booking-report/sync', {
    body: { from_date: '2026-09-01', to_date: '2026-09-21', confirmed_marketing: true }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.accepted, 1);
  assert.equal(result.body.done, true);
  const upsert = sqlCalls.find((call) => /INSERT INTO revisit_email_bookings/.test(call.sql));
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT \(source_system, external_booking_id\) DO UPDATE/);
  const inserted = JSON.parse(upsert.params[0]);
  assert.equal(inserted[0].booking_status, 'completed');
  assert.equal(inserted[0].customer_email, 'guest@example.com');
  assert.match(inserted[0].booking_url, /utm_campaign=revisit_email/);
});

test('大量訂位會分批同步並沿用同一筆匯入紀錄', async () => {
  const sourceFile = '訂位成效報表 2026-09-01～2026-09-21';
  const progress = { received: 0, accepted: 0, rejected: 0, status: 'uploading' };
  const client = {
    async query(sql, params) {
      if (/SELECT id, kind, source_file, status, received_count/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: 77, kind: 'bookings', source_file: sourceFile, status: progress.status,
          received_count: progress.received, accepted_count: progress.accepted,
          rejected_count: progress.rejected, uploaded_by: 'admin'
        }] };
      }
      if (/UPDATE revisit_email_imports SET/.test(sql)) {
        progress.received += Number(params[1]);
        progress.accepted += Number(params[2]);
        progress.rejected += Number(params[3]);
        if (params[5]) progress.status = 'completed';
        return { rowCount: 1, rows: [{
          received_count: progress.received,
          accepted_count: progress.accepted,
          rejected_count: progress.rejected
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const offsets = [];
  const routes = register({
    bookingReportClient: {
      isConfigured: () => true,
      async fetchPage({ offset, limit }) {
        offsets.push({ offset, limit });
        return { total: 2, rows: [{
          booking_ref_id: `BK-${offset + 1}`, or_restaurant_id: 'OR-9', restaurant_name: '測試餐廳',
          status: 'Confirm', booking_date: '2026-09-01', diner_name_full: '測試客',
          email_full: `guest${offset + 1}@example.com`
        }] };
      }
    },
    query: async (sql) => {
      if (/INSERT INTO revisit_email_imports/.test(sql)) return { rowCount: 1, rows: [{ id: 77 }] };
      return { rowCount: 1, rows: [] };
    },
    pool: { connect: async () => client }
  });

  const first = await run(routes, 'POST /admin/revisit-email/api/booking-report/sync', {
    body: { from_date: '2026-09-01', to_date: '2026-09-21', confirmed_marketing: true }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.done, false);
  assert.equal(first.body.next_offset, 1);
  assert.equal(first.body.import_id, 77);

  const second = await run(routes, 'POST /admin/revisit-email/api/booking-report/sync', {
    body: { from_date: '2026-09-01', to_date: '2026-09-21', confirmed_marketing: true, import_id: 77, offset: 1 }
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.done, true);
  assert.equal(second.body.accepted, 2);
  assert.deepEqual(offsets, [{ offset: 0, limit: 500 }, { offset: 1, limit: 500 }]);
});

test('未確認行銷同意前不會向訂位成效報表讀取資料', async () => {
  let fetched = false;
  const routes = register({
    bookingReportClient: { isConfigured: () => true, async fetchPage() { fetched = true; return { total: 0, rows: [] }; } }
  });
  const result = await run(routes, 'POST /admin/revisit-email/api/booking-report/sync', {
    body: { from_date: '2026-09-01', to_date: '2026-09-21', confirmed_marketing: false }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'marketing_confirmation_required');
  assert.equal(fetched, false);
});

test('回訪頁會顯示報表最新訂位日期，狀態查詢失敗也不拖垮頁面', async () => {
  const currentRoutes = register({
    bookingReportClient: {
      isConfigured: () => true,
      async fetchStatus() {
        return { latestBookingDate: '2026-09-20', earliestBookingDate: '2024-01-01', totalBookings: 1234 };
      }
    }
  });
  const current = await run(currentRoutes, 'GET /admin/revisit-email/api/data');
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.booking_report.status_available, true);
  assert.equal(current.body.booking_report.latest_booking_date, '2026-09-20');
  assert.equal(current.body.booking_report.total_bookings, 1234);

  const unavailableRoutes = register({
    bookingReportClient: {
      isConfigured: () => true,
      async fetchStatus() { throw new Error('temporary_source_failure'); }
    }
  });
  const unavailable = await run(unavailableRoutes, 'GET /admin/revisit-email/api/data');
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.body.booking_report.configured, true);
  assert.equal(unavailable.body.booking_report.status_available, false);
  assert.equal(unavailable.body.booking_report.latest_booking_date, null);
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
  assert.equal(mail.subject, '歡迎回來');
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
