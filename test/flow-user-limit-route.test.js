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

test('開啟活動流程會保存活動與 HTTPS 目的地', async () => {
  const routes = {};
  let saved = null;
  const client = {
    async query(sql, params) {
      if (/INSERT INTO admin_flows/.test(String(sql))) {
        saved = params;
        return { rows: [{ id: 89 }], rowCount: 1 };
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
      name: '分享超有哩開啟後追蹤',
      trigger: { type: 'campaign_open', config: {
        activity_id: 6, campaign_name: '分享超有哩',
        target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles',
        user_limit: { max: 1, window: 'lifetime' }
      } },
      steps: [{ type: 'send', message_id: 9 }]
    },
    authUser: { un: 'admin' }
  });
  assert.equal(res.body.ok, true);
  assert.equal(saved[1], 'campaign_open');
  assert.deepEqual(JSON.parse(saved[2]), {
    activity_id: 6,
    campaign_name: '分享超有哩',
    target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles',
    user_limit: { max: 1, window: 'lifetime' }
  });
});

test('外部活動只接受 HTTPS 網址', async () => {
  const routes = {};
  registerAdminFlowsRoutes(makeApp(routes), {
    query: async () => ({ rows: [], rowCount: 0 }),
    pool: { connect: async () => { throw new Error('不應寫入'); } },
    flowEngine: {},
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  const res = await run(routes['POST /admin/flows/api'], {
    body: {
      name: '外部活動',
      trigger: { type: 'campaign_open', config: { campaign_name: '中秋', target_url: 'javascript:alert(1)' } },
      steps: [{ type: 'send', message_id: 9 }]
    },
    authUser: { un: 'admin' }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'campaign_open_needs_url');
});

test('已啟用的活動入口流程不可刪除，只能暫停以保住已發出的網址', async () => {
  const routes = {};
  let deleted = false;
  registerAdminFlowsRoutes(makeApp(routes), {
    query: async sql => {
      if (/SELECT trigger_type, status FROM admin_flows/.test(String(sql))) {
        return { rows: [{ trigger_type: 'campaign_open', status: 'active' }], rowCount: 1 };
      }
      if (/DELETE FROM admin_flows/.test(String(sql))) deleted = true;
      return { rows: [], rowCount: 0 };
    },
    pool: {}, flowEngine: {},
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  const res = await run(routes['DELETE /admin/flows/api/:id'], { params: { id: '12' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'campaign_flow_use_pause');
  assert.equal(deleted, false);
});
