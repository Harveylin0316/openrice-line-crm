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
    statusCode: 200, body: null, rendered: null, locals: null, redirected: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render(view, locals) { this.rendered = view; this.locals = locals; return this; },
    redirect(url) { this.redirected = url; return this; },
    setHeader(k, v) { this.headers[k] = v; }
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

function build(opts = {}) {
  const routes = {}, tapRows = [], triggers = [];
  const flow = {
    id: 31, name: '中秋追蹤', status: opts.status || 'active', trigger_type: 'campaign_open',
    trigger_config: { campaign_name: '中秋開飯驚喜', target_url: 'https://tw.openrice.com/info/event/midautumn' }
  };
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM admin_flows/.test(q) && /trigger_type = 'campaign_open'/.test(q)) {
      return { rows: Number(params[0]) === 31 ? [flow] : [], rowCount: Number(params[0]) === 31 ? 1 : 0 };
    }
    if (/INSERT INTO message_taps/.test(q)) { tapRows.push(params); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  registerAdminFlowsRoutes(makeApp(routes), {
    query,
    pool: { connect: async () => { throw new Error('not used'); } },
    flowEngine: { triggerCampaignOpen: async args => { triggers.push(args); return { enrolled: 1 }; } },
    verifyLiffIdToken: async token => opts.badToken || token !== 'valid'
      ? { ok: false }
      : { ok: true, sub: 'U' + 'a'.repeat(32) },
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  return { routes, tapRows, triggers };
}

test('活動入口會渲染 LIFF 跳板並保留真正目的地', async () => {
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const x = build();
  const key = 'GET /ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)';
  const res = await run(x.routes[key], { params: { id: '31', source: 'broadcast' }, body: {} });
  assert.equal(res.rendered, 'tap_bounce');
  assert.equal(res.locals.target, 'https://tw.openrice.com/info/event/midautumn');
  assert.equal(res.locals.liffId, '2000000000-test');
  assert.equal(res.locals.recordUrl, '/ce/31/broadcast/hit');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('通過 LINE 驗證才記來源並觸發綁定流程', async () => {
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const x = build();
  const key = 'POST /ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)/hit';
  const res = await run(x.routes[key], {
    params: { id: '31', source: 'welcome' }, body: { id_token: 'valid' }, headers: {}, ip: '1.1.1.1'
  });
  assert.equal(res.body.ok, true);
  assert.equal(x.tapRows.length, 1);
  assert.deepEqual(x.tapRows[0].slice(0, 3), ['31_welcome', '中秋開飯驚喜', 'https://tw.openrice.com/info/event/midautumn']);
  assert.equal(x.triggers.length, 1);
  assert.deepEqual(x.triggers[0], { flowId: 31, lineUserId: 'U' + 'a'.repeat(32), source: 'welcome' });
});

test('偽造或遺失 token 不會記錄也不會進流程', async () => {
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const x = build({ badToken: true });
  const key = 'POST /ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)/hit';
  const res = await run(x.routes[key], {
    params: { id: '31', source: 'richmenu' }, body: { id_token: 'fake' }, headers: {}, ip: '1.1.1.1'
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'identity_verification_failed');
  assert.equal(x.tapRows.length, 0);
  assert.equal(x.triggers.length, 0);
});

test('流程暫停時入口仍可前往活動，觸發是否生效交由引擎依 active 狀態判定', async () => {
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const x = build({ status: 'paused' });
  const key = 'GET /games/ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)';
  const res = await run(x.routes[key], { params: { id: '31', source: 'other' }, body: {} });
  assert.equal(res.rendered, 'tap_bounce');
  assert.equal(res.locals.target, 'https://tw.openrice.com/info/event/midautumn');
});
