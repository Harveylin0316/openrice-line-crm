'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminUsersRoutes } = require('../src/routes/adminUsers');

function setup(query) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    put() {}, delete() {}
  };
  const pass = (_req, _res, next) => next();
  registerAdminUsersRoutes(app, {
    query,
    pool: { query },
    authCore: { requireAdmin: pass, requireOwner: pass }
  });
  return routes;
}

async function run(handlers, body) {
  const req = { body, authUser: { un: 'admin' }, get: () => '' };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test('deleting a tag rule can remove only members owned by that rule', async () => {
  let call;
  const routes = setup(async (sql, params) => {
    call = { sql: String(sql).replace(/\s+/g, ' '), params };
    return { rows: [{ id: 9, removed_members: 4 }], rowCount: 1 };
  });
  const res = await run(routes['POST /admin/users/api/tag-rules/delete'], { id: 9, remove_members: true });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.removed_members, 4);
  assert.match(call.sql, /DELETE FROM user_tag_members WHERE source_rule_id = \$1/);
  assert.deepEqual(call.params, [9, true]);
});

test('disabling a tag rule may retain generated members when requested', async () => {
  let call;
  const routes = setup(async (sql, params) => {
    call = { sql: String(sql).replace(/\s+/g, ' '), params };
    return { rows: [{ active: false, removed_members: 0 }], rowCount: 1 };
  });
  const res = await run(routes['POST /admin/users/api/tag-rules/toggle'], { id: 9, remove_members: false });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.active, false);
  assert.match(call.sql, /m\.source_rule_id = t\.id/);
  assert.deepEqual(call.params, [9, false]);
});
