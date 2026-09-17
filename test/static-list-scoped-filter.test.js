'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { previewAudience } = require('../src/core/audienceSegments');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

const uid = ch => 'U' + ch.repeat(32);

test('static-list preview intersects audience conditions with only the pasted IDs', async () => {
  const ids = [uid('a'), uid('b'), uid('c')];
  const calls = [];
  const query = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ');
    calls.push({ text, params });
    if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 2 }] };
    return { rows: [
      { line_user_id: ids[0], display_name: 'A' },
      { line_user_id: ids[2], display_name: 'C' }
    ] };
  };

  const result = await previewAudience(
    query,
    { operator: 'and', conditions: [{ mode: 'include', type: 'is_friend', value: null }] },
    10,
    { scopeLineUserIds: ids }
  );

  assert.equal(result.total, 2);
  assert.equal(result.scope.inputTotal, 3);
  assert.match(calls[0].text, /u\.line_user_id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].params, [ids]);
  assert.ok(result.total <= result.scope.inputTotal);
});

test('static-list creation saves the same filtered intersection shown by preview', async () => {
  const routes = {};
  const app = {
    get(pathname, ...handlers) { routes['GET ' + pathname] = handlers; },
    post(pathname, ...handlers) { routes['POST ' + pathname] = handlers; },
    put(pathname, ...handlers) { routes['PUT ' + pathname] = handlers; },
    delete(pathname, ...handlers) { routes['DELETE ' + pathname] = handlers; }
  };
  const ids = [uid('a'), uid('b'), uid('c')];
  const filtered = [ids[0], ids[2]];
  const clientCalls = [];
  const client = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ');
      clientCalls.push({ text, params: params || [] });
      if (/INSERT INTO admin_recipient_lists/.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 91, name: '提醒領取獎勵', description: null, total: 2, created_by: 'admin' }]
        };
      }
      return { rowCount: /INSERT INTO admin_recipient_list_members/.test(text) ? 2 : 0, rows: [] };
    },
    release() {}
  };
  registerAdminBroadcastRoutes(app, {
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ');
      if (/SELECT audience\.line_user_id/.test(text)) {
        assert.match(text, /u\.line_user_id = ANY\(\$1::text\[\]\)/);
        assert.deepEqual(params, [ids]);
        return { rows: filtered.map(line_user_id => ({ line_user_id })), rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    },
    pool: { connect: async () => client },
    authCore: { requireAdmin: (_req, _res, next) => next() },
    linePush: null,
    emailProvider: null,
    lineChannelAccessToken: '',
    resolvePublicSiteOrigin: () => ''
  });

  const req = {
    body: {
      name: '提醒領取獎勵',
      lineUserIds: ids,
      filterDefinition: {
        operator: 'and',
        conditions: [{ mode: 'include', type: 'is_friend', value: null }]
      }
    },
    authUser: { un: 'admin' }
  };
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(body) { this.body = body; return this; }
  };
  for (const handler of routes['POST /admin/broadcast/recipient-lists']) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }

  assert.equal(res.body.ok, true);
  assert.equal(res.body.importedValid, 3);
  assert.equal(res.body.accepted, 2);
  assert.equal(res.body.filteredOut, 1);
  const listInsert = clientCalls.find(call => /INSERT INTO admin_recipient_lists/.test(call.text));
  assert.equal(listInsert.params[2], 2);
  const memberInsert = clientCalls.find(call => /INSERT INTO admin_recipient_list_members/.test(call.text));
  assert.deepEqual(memberInsert.params, [91, ids[0], 91, ids[2]]);
});

test('recipient-list UI labels and sends the imported-ID scope instead of global preview', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views/admin_recipient_lists.ejs'), 'utf8');
  assert.match(view, /例如貼入 64 位用戶後選「目前仍是好友」/);
  assert.match(view, /scopeLineUserIds:scopedUids/);
  assert.match(view, /filterDefinition:\$\('static-filter-enabled'\)\.checked/);
  assert.match(view, /匯入 <strong>/);
  assert.match(view, /#dynamic-inputs\[hidden\].*display: none !important/);
});
