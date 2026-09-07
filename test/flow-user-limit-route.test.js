const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminFlowsRoutes } = require('../src/routes/adminFlows');

function makeApp(routes) {
  return ['get', 'post', 'put', 'delete'].reduce((app, method) => {
    app[method] = (path, ...handlers) => { routes[method.toUpperCase() + ' ' + path] = handlers; };
    return app;
  }, {});
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function run(handlers, req) {
  const res = makeRes();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test('流程可儲存每人最多三次，並自動開啟完成後重入', async () => {
  const routes = {};
  let savedFlowParams = null;
  const client = {
    async query(sql, params) {
      if (/INSERT INTO admin_flows/.test(String(sql))) {
        savedFlowParams = params;
        return { rows: [{ id: 88 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  registerAdminFlowsRoutes(makeApp(routes), {
    query: async () => ({ rows: [], rowCount: 0 }),
    pool: { connect: async () => client },
    flowEngine: {},
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  const res = await run(routes['POST /admin/flows/api'], {
    body: {
      name: '最多三次',
      trigger: { type: 'follow', config: { user_limit: { max: 3, window: 'lifetime' } } },
      steps: [{ type: 'send', message_id: 9 }],
      re_enroll: false
    },
    authUser: { un: 'admin' }
  });
  assert.equal(res.body.ok, true);
  assert.deepEqual(JSON.parse(savedFlowParams[2]).user_limit, { max: 3, window: 'lifetime' });
  assert.equal(savedFlowParams[3], true);
});

test('每人觸發上限只接受 1 到 1000', async () => {
  const routes = {};
  registerAdminFlowsRoutes(makeApp(routes), {
    query: async () => ({ rows: [], rowCount: 0 }),
    pool: { connect: async () => { throw new Error('不應寫入'); } },
    flowEngine: {},
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  const res = await run(routes['POST /admin/flows/api'], {
    body: {
      name: '錯誤上限',
      trigger: { type: 'follow', config: { user_limit: { max: 0, window: 'lifetime' } } },
      steps: [{ type: 'send', message_id: 9 }]
    },
    authUser: { un: 'admin' }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_user_trigger_limit');
});
