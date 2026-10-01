const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const express = require('express');
const { registerAdminPushLogsRoutes, parseFilters, filterUrl, detailSql } = require('../src/routes/adminPushLogs');
const { SOURCES, diagnosePush, decoratePush, messageSummary, taipeiTime, csvCell } = require('../src/core/pushLogDiagnostics');
const { createLinePushService } = require('../src/core/linePush');
const VIEWS = path.join(__dirname, '../views');
const fixture = (id = 1) => ({ id, created_at: '2026-09-30T11:11:12.123Z', cursor_time: '2026-09-30T11:11:12.123456Z', line_user_id: 'Ufixture0001', line_display_name: '測試客人', status: 'failed', http_status: 429, detail: '{"message":"You have reached your monthly limit."}', push_type: 'flow', payload: { messages: [{ type: 'text', text: '歡迎回訪' }], retryKey: 'flow-1-node', messageName: '回訪提醒' }, flow_id: 2, flow_name: '測試流程', flow_status: 'active' });

function harness(query) {
  let handler;
  const gate = (_req, _res, next) => next();
  registerAdminPushLogsRoutes({ get(url, middleware, callback) { assert.equal(url, '/admin/push-logs'); assert.equal(middleware, gate); handler = callback; } }, { query, authCore: { requireAdmin: gate } });
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, render(view, data) { this.view = view; this.data = data; return this; }, type(t) { this.contentType = t; return this; }, send(v) { this.body = v; return this; } };
  return { res, run: queryParams => handler({ query: queryParams || {}, authUser: { un: 'tester' } }, res) };
}

test('different LINE failures provide actionable guidance without promising delivery or blindly retrying', () => {
  assert.match(diagnosePush(fixture()).cause, /額度/);
  assert.match(diagnosePush(fixture()).action, /當時.*不代表今天/);
  for (const code of [401, 403]) assert.match(diagnosePush({ status: 'failed', http_status: code }).cause, /權限/);
  assert.match(diagnosePush({ status: 'failed', http_status: 429 }).cause, /速度/);
  assert.match(diagnosePush({ status: 'failed', http_status: 400, detail: 'Invalid reply token' }).cause, /憑證/);
  assert.match(diagnosePush({ status: 'failed', http_status: 400, detail: "The property, 'to', is invalid" }).cause, /編號/);
  assert.match(diagnosePush({ status: 'failed', http_status: 400 }).cause, /格式/);
  assert.match(diagnosePush({ status: 'failed', http_status: 500 }).action, /不代表一定沒寄出/);
  assert.match(diagnosePush({ status: 'failed', detail: 'fetch failed' }).cause, /待確認/);
  assert.match(diagnosePush({ status: 'failed', http_status: 409 }).action, /不要再補發/);
  assert.match(diagnosePush({ status: 'success' }).action, /不是.*送達/);
});

test('message summary preserves ordered text + custom Flex contents without loading tracking images', () => {
  const result = messageSummary({ messages: [{ type: 'text', text: '前導文字' }, { type: 'flex', altText: '新訊息', contents: { type: 'bubble', body: { type: 'box', contents: [{ type: 'image', url: 'https://example.com/tracking' }, { type: 'text', text: '回饋金入帳' }, { type: 'button', action: { type: 'uri', label: '查看回饋金', uri: 'https://example.com' } }] } } }] });
  assert.match(result, /1\. 文字：前導文字\n2\. 卡片：新訊息\n回饋金入帳\n查看回饋金/);
  assert.doesNotMatch(result, /tracking/);
  assert.match(messageSummary(null), /舊紀錄/);
});

test('time ranges are inclusive Taiwan days; invalid dates/arrays/cursors fail safely', () => {
  const parsed = parseFilters({ range: 'custom', from: '2026-09-01', to: '2026-09-30', q: 'a%_\\' });
  assert.deepEqual(parsed.values.slice(1, 3), ['2026-09-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00']);
  assert.equal(parsed.values[3], '%a\\%\\_\\\\%');
  for (const raw of [{ range: 'custom', from: '2026-02-30', to: '2026-03-01' }, { range: 'custom', from: '2026-10-02', to: '2026-10-01' }, { range: 'custom', from: '2024-01-01', to: '2026-10-01' }, { range: 'oops' }, { status: 'oops' }, { after: 'oops', beforeId: '1' }, { beforeId: '1' }]) assert.throws(() => parseFilters(raw));
  assert.equal(parseFilters({ q: ['one', 'two'] }).filters.q, '');
  assert.match(taipeiTime('2026-09-30T17:00:00Z'), /2026\/10\/01 01:00:00/);
});

test('parameters cannot inject SQL; legacy IDs guarded; recovery matches same message, person and source', () => {
  const input = "x' OR 1=1 --";
  const p = parseFilters({ status: 'all', range: 'all', q: input });
  assert.ok(!p.where.includes(input));
  assert.ok(p.values[0].includes(input));
  const sql = detailSql(p.where, '$2');
  assert.match(sql, /LIMIT \$2/);
  assert.match(sql, /\^flow-/);
  assert.match(sql, /\^bc-/);
  assert.match(sql, /\[0-9\]\{1,15\}/);
  assert.match(sql, /s\.line_user_id = l\.line_user_id/);
  assert.match(sql, /s\.push_type = l\.push_type/);
  assert.match(sql, /s\.payload->>'retryKey' = l\.payload->>'retryKey'/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /HH24:MI:SS.US/);
});

test('pending and recovered filters only operate on failed attempts; another success is not recovery', () => {
  const pending = parseFilters({ followup: 'pending', range: 'all' });
  assert.match(pending.where, /NOT \(l.status = 'failed'/);
  assert.match(pending.where, /s\.payload->>'retryKey' = l\.payload->>'retryKey'/);
  const recovered = parseFilters({ followup: 'recovered', range: 'all' });
  assert.doesNotMatch(recovered.where, /NOT \(/);
  assert.match(recovered.where, /EXISTS/);
  assert.equal(parseFilters({ status: 'success', followup: 'pending' }).filters.followup, 'all');
  assert.throws(() => parseFilters({ followup: 'invalid' }));
  assert.match(decoratePush({ ...fixture(), recovered: true }).followUp, /不需另行補發/);
  assert.match(decoratePush({ ...fixture(), recovered: false }).followUp, /仍在執行/);
});

test('custom-date UX opens date controls, requires both dates and clears disabled fields outside custom', async () => {
  const html = await ejs.renderFile(path.join(VIEWS, 'admin_push_logs.ejs'), { user: 'tester', isAdmin: true, title: '紀錄', filters: parseFilters().filters, stats: {}, rows: [], nextHref: '', error: '', SOURCES, taipeiTime, filterUrl }, { views: [VIEWS] });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/admin/push-logs' });
  const document = dom.window.document, range = document.querySelector('[name="range"]');
  assert.equal(document.querySelector('.pl-more').open, false);
  assert.equal(document.querySelector('[name="from"]').disabled, true);
  range.value = 'custom'; range.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('.pl-more').open, true);
  assert.equal(document.querySelector('[name="from"]').required, true);
  assert.equal(document.querySelector('[name="to"]').disabled, false);
  range.value = '7d'; range.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('[name="from"]').disabled, true);
  dom.window.close();
});

test('default listing counts attempts and people separately, keeps precise cursor and all filters', async () => {
  const calls = [];
  const h = harness(async (sql, values) => { calls.push({ sql, values }); return calls.length === 1 ? { rows: [{ total: 343, people: 99, failed: 343, monthly: 343 }] } : { rows: Array.from({ length: 51 }, (_, i) => fixture(100 - i)) }; });
  await h.run({ range: '7d', source: 'flow', q: '客人' });
  assert.equal(h.res.data.stats.people, 99);
  assert.equal(h.res.data.rows.length, 50);
  assert.match(h.res.data.nextHref, /123456Z/);
  const next = new URL(h.res.data.nextHref, 'https://example.com');
  assert.equal(next.searchParams.get('range'), '7d');
  assert.equal(next.searchParams.get('source'), 'flow');
  assert.equal(next.searchParams.get('q'), '客人');
  assert.equal(next.searchParams.get('beforeId'), '51');
  assert.match(calls[0].sql, /COUNT\(DISTINCT/);
  assert.match(calls[1].sql, /WITH selected_logs/);
  assert.equal(calls[1].values.at(-1), 51);
  assert.equal(h.res.headers['Cache-Control'], 'no-store, must-revalidate');
});

test('cursor uses keyset, export ignores cursor and exports all matching rows with safe CSV cells', async () => {
  const calls = [];
  const h = harness(async (sql, values) => { calls.push({ sql, values }); return calls.length % 2 === 1 ? { rows: [{ total: 60 }] } : { rows: Array.from({ length: 60 }, (_, i) => ({ ...fixture(i + 1), line_display_name: '=HYPERLINK("bad")' })) }; });
  const cursor = { range: 'all', after: '2026-09-30T11:11:12.123456Z', beforeId: '51' };
  await h.run(cursor);
  assert.match(calls[1].sql, /\(l.created_at, l.id\) < /);
  calls.length = 0;
  await h.run({ ...cursor, export: 'csv' });
  assert.doesNotMatch(calls[1].sql, /\(l.created_at, l.id\) < /);
  assert.equal(h.res.body.split('\r\n').length, 61);
  assert.equal(h.res.body.charCodeAt(0), 0xfeff);
  assert.match(h.res.body, /'=HYPERLINK/);
  assert.equal(h.res.headers['Content-Disposition'], 'attachment; filename="line-push-logs.csv"');
  assert.match(csvCell('  @evil'), /'  @evil/);
  assert.equal(csvCell('U000'), '"U000"');
  const url = filterUrl(cursor, { export: 'csv' });
  assert.doesNotMatch(url, /beforeId|after=/);
});

test('invalid filters, unavailable DB and oversized export are explicit errors, not zero failures', async () => {
  let count = 0;
  const invalid = harness(async () => { count++; throw new Error('never'); });
  await invalid.run({ range: 'custom' });
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(count, 0);
  const oversized = harness(async () => ({ rows: [{ total: 10001 }] }));
  await oversized.run({ export: 'csv' });
  assert.equal(oversized.res.statusCode, 413);
  const unavailable = harness(async () => { throw new Error('secret database credentials'); });
  await unavailable.run({});
  assert.equal(unavailable.res.statusCode, 500);
  assert.match(unavailable.res.data.error, /不代表沒有失敗/);
  assert.doesNotMatch(unavailable.res.data.error, /secret/);
});

test('view safely escapes recipients, raw LINE errors, Flex contents; original-source link and no resend control', async () => {
  const malicious = '<img src=x onerror="alert(1)"><script>bad()</script>';
  const row = decoratePush({ ...fixture(), line_display_name: malicious, detail: malicious, payload: { messages: [{ type: 'text', text: malicious }] }, recovered: true });
  const html = await ejs.renderFile(path.join(VIEWS, 'admin_push_logs.ejs'), { user: 'tester', isAdmin: true, title: '紀錄', filters: parseFilters().filters, stats: { total: 1, people: 1, failed: 1 }, rows: [row], nextHref: '', error: '', SOURCES, taipeiTime, filterUrl }, { views: [VIEWS] });
  assert.ok(!html.includes(malicious));
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelectorAll('main img').length, 0);
  assert.equal(dom.window.document.querySelectorAll('main script').length, 1, 'only the known date-filter script is executable');
  assert.match(dom.window.document.querySelector('main').textContent, /同一則後續已被 LINE 接受/);
  assert.ok(dom.window.document.querySelector('a[href="/admin/flows"]'));
  assert.ok(!dom.window.document.querySelector('main form[method="post"]'));
  assert.equal(dom.window.document.querySelector('.pl-id').textContent.includes('Ufixture0001'), true);
  dom.window.close();
});

test('new page and export require existing admin auth gate over real HTTP', async t => {
  const app = express();
  app.set('views', VIEWS); app.set('view engine', 'ejs');
  let queried = false;
  registerAdminPushLogsRoutes(app, { query: async () => { queried = true; return { rows: [] }; }, authCore: { requireAdmin: (req, res) => res.status(401).send('Login required') } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  for (const suffix of ['', '?export=csv']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/push-logs${suffix}`);
    assert.equal(response.status, 401);
  }
  assert.equal(queried, false);
});

test('adding diagnostic metadata does not alter the actual LINE request or retry header', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let sent, logged;
  global.fetch = async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, status: 200 }; };
  const push = createLinePushService({ lineChannelAccessToken: 'fake-token', query: async (_sql, values) => { logged = JSON.parse(values[6]); } });
  assert.equal(await push.pushLineMessages('Ufake', ['Hello'], { pushType: 'flow', retryKey: 'flow-1-node', enrollmentId: 1, messageId: 2, messageName: '測試訊息' }), true);
  assert.deepEqual(sent, { to: 'Ufake', messages: [{ type: 'text', text: 'Hello' }] });
  assert.equal(logged.enrollmentId, 1); assert.equal(logged.messageName, '測試訊息');
});

test('dashboard warning and legacy report link directly to filtered failure diagnostics', () => {
  const dashboard = fs.readFileSync(path.join(VIEWS, 'admin_dashboard.ejs'), 'utf8');
  assert.match(dashboard, /次推播失敗.*href:'\/admin\/push-logs\?status=failed&range=24h&followup=pending'/);
  const reports = fs.readFileSync(path.join(VIEWS, 'admin_reports.ejs'), 'utf8');
  assert.match(reports, /href="\/admin\/push-logs\?status=failed&range=all"/);
  assert.match(reports, /完整發送紀錄與匯出/);
});
