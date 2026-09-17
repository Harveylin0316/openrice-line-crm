'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncDynamicList } = require('../src/core/audienceSegments');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

test('dynamic list sync atomically replaces members and records the fresh count', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ');
      calls.push({ text, params: params || [] });
      if (/SELECT id, definition/.test(text)) return { rows: [{ id: 7, definition: { conditions: [{ type: 'tag', value: 3 }] } }] };
      if (/INSERT INTO admin_recipient_list_members/.test(text)) return { rowCount: 42, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); }
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] })
  };
  const out = await syncDynamicList(pool, 7);
  assert.equal(out.total, 42);
  assert.equal(calls[0].text, 'BEGIN');
  assert.ok(calls.some(c => /DELETE FROM admin_recipient_list_members/.test(c.text)));
  const insert = calls.find(c => /INSERT INTO admin_recipient_list_members/.test(c.text));
  assert.deepEqual(insert.params, [3, 7]);
  assert.match(insert.text, /SELECT \$2, audience\.line_user_id/);
  assert.ok(calls.some(c => /last_sync_status = 'ok'/.test(c.text)));
  assert.ok(calls.some(c => c.text === 'COMMIT'));
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('broadcast preview refreshes a saved dynamic list before counting recipients', async () => {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    delete(path, ...handlers) { routes['DELETE ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; }
  };
  const order = [];
  const query = async (sql) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT list_type FROM admin_recipient_lists/.test(text)) { order.push('detect'); return { rows: [{ list_type: 'dynamic' }] }; }
    if (/SELECT COUNT\(\*\)::int AS n FROM admin_recipient_list_members/.test(text)) { order.push('count'); return { rows: [{ n: 5 }] }; }
    if (/SELECT m\.id, m\.line_user_id/.test(text)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ');
      if (/SELECT id, definition/.test(text)) return { rows: [{ id: 7, definition: { conditions: [{ type: 'is_friend' }] } }] };
      if (/INSERT INTO admin_recipient_list_members/.test(text)) { order.push('sync'); return { rowCount: 5, rows: [] }; }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  registerAdminBroadcastRoutes(app, {
    query, pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    authCore: { requireAdmin: (_req, _res, next) => next() },
    linePush: null, emailProvider: null, lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ''
  });
  const req = { body: { channel: 'line', conditions: { savedListId: 7 } }, authUser: { un: 'admin' }, get: () => '' };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  for (const handler of routes['POST /admin/broadcast/audience/preview']) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total, 5);
  assert.deepEqual(order, ['detect', 'sync', 'count']);
});
