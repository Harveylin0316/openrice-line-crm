'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminCampaignPerformanceRoutes, normalizeRange, campaignName, audienceName } = require('../src/routes/adminCampaignPerformance');

test('campaign performance validates date range', () => {
  assert.deepEqual(normalizeRange({ from: '2026-09-01', to: '2026-09-17' }), { from: '2026-09-01', to: '2026-09-17' });
  assert.throws(() => normalizeRange({ from: '2026-10-01', to: '2026-09-17' }), /日期/);
  assert.throws(() => normalizeRange({ from: 'x', to: '2026-09-17' }), /日期/);
});

test('campaign performance defaults use Taipei date instead of UTC date', () => {
  assert.deepEqual(
    normalizeRange({}, new Date('2026-09-16T16:30:00.000Z')),
    { from: '2026-08-19', to: '2026-09-17' }
  );
});

test('campaign name uses subject, creative title, then id', () => {
  assert.equal(campaignName({ id: 1, email_subject: 'Email A', message_config: {} }), 'Email A');
  assert.equal(campaignName({ id: 2, message_config: { template: { title: 'LINE B' } } }), 'LINE B');
  assert.equal(campaignName({ id: 3, message_config: {} }), '群發 #3');
});

test('campaign performance names the audience being compared', () => {
  assert.equal(audienceName({ audience_list_name: '近 7 天新好友' }), '近 7 天新好友');
  assert.equal(audienceName({ audience_config: { conditions: { savedListId: 9 } } }), '已存名單 #9');
  assert.equal(audienceName({ audience_config: { conditions: { directUserIds: ['U1'] } } }), '直接 LINE User ID');
  assert.equal(audienceName({ audience_config: { conditions: { allMembers: true } } }), '全部會員');
  assert.equal(audienceName({ audience_config: { conditions: { joinedDays: 7 } } }), '條件篩選');
});

test('campaign funnel uses real registration timestamp and historical block events', async () => {
  const routes = {};
  const sqlCalls = [];
  const query = async (sql) => {
    sqlCalls.push(String(sql).replace(/\s+/g, ' '));
    return { rows: [] };
  };
  const app = {
    get(path, ...handlers) { routes[path] = handlers; }
  };
  registerAdminCampaignPerformanceRoutes(app, {
    query,
    authCore: { requireAdmin: (_req, _res, next) => next() }
  });
  const req = { query: { from: '2026-09-01', to: '2026-09-17' }, authUser: { un: 'admin' } };
  const res = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  for (const handler of routes['/admin/campaign-performance/api']) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  assert.equal(res.body.ok, true);
  assert.match(sqlCalls[0], /pr\.registered_at/);
  assert.doesNotMatch(sqlCalls[0], /pr\.created_at/);
  assert.match(sqlCalls[0], /line_webhook_events/);
  assert.match(sqlCalls[0], /GROUP BY b\.id,b\.created_at/);
  assert.match(sqlCalls[0], /admin_recipient_lists/);
  assert.match(sqlCalls[1], /b\.is_ab_test = true/);
});
