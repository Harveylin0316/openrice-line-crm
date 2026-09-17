const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  normalizeRecipientSelection,
  resolveRecipientSelection,
  fetchAudienceRecipients
} = require('../src/core/broadcastAudience');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.render = () => res;
  res.redirect = () => res;
  res.type = () => res;
  res.send = () => res;
  return res;
}

async function runRoute(handlers, body) {
  const req = {
    body,
    params: {},
    query: {},
    authUser: { uid: 1, un: 'admin' },
    get: () => 'openrice-line-crm.netlify.app'
  };
  const res = makeResponse();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

function trackedMessage() {
  return {
    mode: 'template',
    template: {
      title: '測試',
      subtitle: '內容',
      ctaLabel: '立即查看',
      ctaUrl: 'https://example.com',
      altText: '測試'
    }
  };
}

function buildRouteHarness() {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    delete(path, ...handlers) { routes['DELETE ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; }
  };
  const rows = Array.from({ length: 423 }, (_, i) => ({
    user_id: i + 1,
    line_user_id: 'U' + (i + 1).toString(16).padStart(32, '0')
  }));
  const calls = { query: [], client: [], recipientCount: 0, audienceConfig: null };
  const query = async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    calls.query.push({ sql: compact, params: params.slice() });
    if (/COUNT\(DISTINCT u\.id\)/.test(compact)) return { rows: [{ total: 2000 }], rowCount: 1 };
    if (/ORDER BY RANDOM\(\), u\.id ASC/.test(compact)) return { rows, rowCount: rows.length };
    if (/SELECT u\.id, u\.line_user_id/.test(compact)) return { rows: rows.slice(0, 10), rowCount: 10 };
    return { rows: [], rowCount: 0 };
  };
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, ' ');
      calls.client.push({ sql: compact, params: params.slice() });
      if (/INSERT INTO admin_broadcasts/.test(compact)) {
        calls.audienceConfig = JSON.parse(params[1]);
        return { rows: [{ id: 77 }], rowCount: 1 };
      }
      if (/INSERT INTO admin_broadcast_recipients/.test(compact)) {
        calls.recipientCount += params.length / 6;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pass = (_req, _res, next) => next();
  registerAdminBroadcastRoutes(app, {
    query,
    pool: { connect: async () => client },
    authCore: { requireAdmin: pass },
    linePush: { validatePushMessages: async () => ({ ok: true }) },
    emailProvider: { isConfigured: () => false },
    lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://openrice-line-crm.netlify.app'
  });
  return { routes, calls };
}

test('指定發送人數只接受 1 到 5000 的整數，未設定時保持全部發送', () => {
  assert.deepEqual(normalizeRecipientSelection(), {
    ok: true,
    value: { mode: 'all', count: null },
    error: null
  });
  assert.equal(normalizeRecipientSelection({ mode: 'random', count: 423 }).value.count, 423);
  assert.equal(normalizeRecipientSelection({ mode: 'random', count: 0 }).ok, false);
  assert.equal(normalizeRecipientSelection({ mode: 'random', count: 5001 }).ok, false);
  assert.equal(normalizeRecipientSelection({ mode: 'random', count: 42.3 }).ok, false);
});

test('2000 位符合者可精確設定隨機發送 423 位，超過母體時整批擋下', () => {
  const selected = resolveRecipientSelection({ mode: 'random', count: 423 }, 2000);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.value, {
    mode: 'random',
    count: 423,
    eligibleTotal: 2000,
    sendTotal: 423
  });

  const tooMany = resolveRecipientSelection({ mode: 'random', count: 2001 }, 2000);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /只有 2000 位符合條件/);
});

test('全部發送仍受單批 5000 人上限保護，預覽數字不會假裝全部都會收到', () => {
  const selected = resolveRecipientSelection({ mode: 'all' }, 8000);
  assert.equal(selected.ok, true);
  assert.equal(selected.value.eligibleTotal, 8000);
  assert.equal(selected.value.sendTotal, 5000);
});

test('正式取名單會從完整符合者隨機抽精確人數', async () => {
  const calls = [];
  const rows = Array.from({ length: 423 }, (_, i) => ({
    user_id: i + 1,
    line_user_id: 'U' + (i + 1).toString(16).padStart(32, '0')
  }));
  const result = await fetchAudienceRecipients(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params.slice() });
    return { rows };
  }, { allMembers: true }, { limit: 423, randomize: true });

  assert.equal(result.rows.length, 423);
  assert.match(calls[0].sql, /ORDER BY RANDOM\(\), u\.id ASC LIMIT \$1/);
  assert.deepEqual(calls[0].params, [423]);
});

test('群發頁完整呈現人數控制、預覽口徑與送出參數', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views/admin_broadcast.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public/admin-broadcast.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src/routes/adminBroadcast.js'), 'utf8');

  assert.match(view, /id="recipient-selection-mode"/);
  assert.match(view, /隨機抽指定人數/);
  assert.match(view, /id="recipient-selection-count"/);
  assert.match(script, /recipient_selection: collectRecipientSelection\(\)/);
  assert.match(script, /符合條件 <strong>/);
  assert.match(script, /本次隨機發送/);
  assert.match(route, /resolveRecipientSelection/);
  assert.match(route, /randomize: recipientSelection\.mode === 'random'/);
  assert.match(route, /recipients\.length !== recipientSelection\.sendTotal/);
});

test('預覽 API 同時回傳符合 2000 人與本次精確發送 423 人', async () => {
  const ctx = buildRouteHarness();
  const res = await runRoute(ctx.routes['POST /admin/broadcast/audience/preview'], {
    channel: 'line',
    conditions: { allMembers: true },
    recipient_selection: { mode: 'random', count: 423 }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.eligibleTotal, 2000);
  assert.equal(res.body.sendTotal, 423);
  assert.equal(res.body.recipientSelection.mode, 'random');
});

test('建立批次時後端重新計數、隨機取 423 人並把固定名單與設定一起保存', async () => {
  const ctx = buildRouteHarness();
  const res = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line',
    send_mode: 'immediate',
    conditions: { allMembers: true },
    recipient_selection: { mode: 'random', count: 423 },
    message_config: trackedMessage()
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total, 423);
  assert.equal(ctx.calls.recipientCount, 423);
  assert.deepEqual(ctx.calls.audienceConfig.recipientSelection, {
    mode: 'random',
    count: 423,
    eligibleTotal: 2000,
    sendTotal: 423
  });
  assert.equal(ctx.calls.query.some((c) => /ORDER BY RANDOM\(\), u\.id ASC/.test(c.sql)), true);
});

test('指定人數超過完整母體時，後端不建立任何批次', async () => {
  const ctx = buildRouteHarness();
  const res = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line',
    send_mode: 'immediate',
    conditions: { allMembers: true },
    recipient_selection: { mode: 'random', count: 2001 },
    message_config: trackedMessage()
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_recipient_selection');
  assert.match(res.body.detail, /只有 2000 位符合條件/);
  assert.equal(ctx.calls.client.length, 0);
});
