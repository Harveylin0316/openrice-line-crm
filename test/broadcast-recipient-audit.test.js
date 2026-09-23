'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

const uid = ch => 'U' + ch.repeat(32);

function buildHarness(query) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; },
    delete(path, ...handlers) { routes['DELETE ' + path] = handlers; }
  };
  registerAdminBroadcastRoutes(app, {
    query,
    pool: { connect: async () => { throw new Error('not used'); } },
    authCore: { requireAdmin: (_req, _res, next) => next() },
    linePush: {},
    emailProvider: null,
    lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://crm.example'
  });
  return routes;
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function run(handlers, req) {
  const res = makeResponse();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test('完整收件人 CSV 會匯出全部資料並防止試算表公式注入', async () => {
  const ids = [uid('a'), uid('b')];
  const routes = buildHarness(async (sql) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT \* FROM admin_broadcasts/.test(text)) {
      return { rowCount: 1, rows: [{ id: 10 }] };
    }
    if (/FROM admin_broadcast_recipients r/.test(text) && /display_name/.test(text)) {
      return {
        rowCount: 2,
        rows: [
          { id: 1, line_user_id: ids[0], status: 'sent', pushed_at: '2026-09-18T10:00:00Z', error: null, display_name: '=HYPERLINK("bad")' },
          { id: 2, line_user_id: ids[1], status: 'failed', pushed_at: null, error: 'blocked', display_name: '正常名稱' }
        ]
      };
    }
    throw new Error('unexpected query: ' + text);
  });

  const res = await run(routes['GET /admin/broadcast/:id(\\d+)/recipients.csv'], {
    params: { id: '10' }, body: {}, query: {}, get: () => '', authUser: { un: 'admin' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /broadcast-10-recipients\.csv/);
  assert.ok(res.body.startsWith('\ufeff'));
  assert.match(res.body, /已送出/);
  assert.match(res.body, /失敗/);
  assert.match(res.body, /'=HYPERLINK/);
  assert.match(res.body, new RegExp(ids[1]));
});
test('原始名單比對會回傳進入批次與被排除的人數及原因', async () => {
  const ids = [uid('a'), uid('b')];
  const routes = buildHarness(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT id FROM admin_broadcasts/.test(text)) {
      return { rowCount: 1, rows: [{ id: 10 }] };
    }
    if (/WITH input AS/.test(text)) {
      assert.deepEqual(params, [10, ids]);
      return {
        rowCount: 2,
        rows: [
          { line_user_id: ids[0], recipient_id: 3156, status: 'sent', comparison_reason: '已進入批次' },
          { line_user_id: ids[1], recipient_id: null, status: null, comparison_reason: '已封鎖官方帳號' }
        ]
      };
    }
    throw new Error('unexpected query: ' + text);
  });

  const res = await run(routes['POST /admin/broadcast/:id(\\d+)/compare-recipients'], {
    params: { id: '10' },
    body: { lineUserIds: ids[0] + '\n' + ids[1] + '\n' + ids[0] + '\nnot-a-user-id' },
    query: {},
    get: () => '',
    authUser: { un: 'admin' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.inputTotal, 2);
  assert.equal(res.body.included, 1);
  assert.equal(res.body.missing, 1);
  assert.equal(res.body.duplicates, 1);
  assert.equal(res.body.invalid, 1);
});
