const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
const { buildBroadcastMessageSnapshots } = require('../src/core/broadcastMessageSnapshot');

const REPO = path.join(__dirname, '..');

function renderDetail(abComparison) {
  return ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast_detail.ejs'), {
    title: '批次 #8', bodyClass: 'admin-shell', user: 'admin', isAdmin: true,
    broadcast: {
      id: 8, created_at: '2026-09-18T04:13:54.000Z', admin_username: 'admin', status: 'done',
      recipient_total: 1292, recipient_ok: 1291, recipient_fail: 0, recipient_skip: 1,
      scheduled_at: null
    },
    statusCounts: [], failedSample: [], recentSample: [], clickRecent: [],
    clickStat: { people: 0, clicks: 0 }, viewStat: { people: 0, views: 0 },
    abStat: [
      { variant: 'a', sent_total: 646, sent_ok: 645, sent_fail: 0, views: 0, clicks: 0 },
      { variant: 'b', sent_total: 646, sent_ok: 646, sent_fail: 0, views: 0, clicks: 0 }
    ],
    abComparison,
    experimentStat: null,
    messageSnapshots: buildBroadcastMessageSnapshots({})
  }, { views: [path.join(REPO, 'views')] });
}

test('A/B 都是零點擊時顯示無勝出版，且不能重發', async () => {
  const html = await renderDetail({ winner: null, reason: 'no_clicks' });
  assert.match(html, /目前沒有勝出版/);
  assert.match(html, /A、B 都沒有 CTA 點擊/);
  assert.match(html, /id="btn-resend-winner" disabled/);
  assert.doesNotMatch(html, /點擊率較高<\/span>/);
  assert.doesNotMatch(html, /預設用 A/);
});

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render() { return this; },
    redirect() { return this; },
    type() { return this; },
    send() { return this; }
  };
}

test('後端在 A/B 平手時也拒絕建立勝出版重發批次', async () => {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((out, method) => {
    out[method] = (routePath, ...handlers) => { routes[method.toUpperCase() + ' ' + routePath] = handlers; };
    return out;
  }, {});
  let poolUsed = false;
  const query = async (sql) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT \* FROM admin_broadcasts WHERE id/.test(text)) {
      return {
        rowCount: 1,
        rows: [{
          id: 8, is_ab_test: true, channel: 'line', audience_config: {},
          message_config: { mode: 'template', template: { title: 'A' } },
          variant_b_message_config: { mode: 'template', template: { title: 'B' } }
        }]
      };
    }
    if (/COUNT\(DISTINCT r\.id\).*AS clickers/.test(text)) {
      return { rowCount: 2, rows: [
        { variant: 'a', sent_ok: 645, clickers: 0 },
        { variant: 'b', sent_ok: 646, clickers: 0 }
      ] };
    }
    throw new Error('unexpected query: ' + text);
  };
  registerAdminBroadcastRoutes(app, {
    query,
    pool: { connect: async () => { poolUsed = true; throw new Error('must not create batch'); } },
    authCore: { requireAdmin: (_req, _res, next) => next() },
    linePush: {}, emailProvider: null, lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://crm.example'
  });

  const req = { params: { id: '8' }, body: {}, query: {}, authUser: { un: 'admin' }, get: () => '' };
  const res = response();
  const handlers = routes['POST /admin/broadcast/:id(\\d+)/resend-winner-to-nonclickers'];
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'winner_not_decided');
  assert.equal(res.body.reason, 'no_clicks');
  assert.equal(poolUsed, false);
});
