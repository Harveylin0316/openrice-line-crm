'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { stagingCaptureEnabled, normalizeFollow, buildStagingRequest, createStagingSender } = require('../src/core/orMissionFollow');
const { createReceiver, signature } = require('../src/core/lineWebhookInbox');
const UID = 'U' + 'a'.repeat(32), SECRET = 'synthetic-mission-secret';
const ENV = { APP_ENV: 'staging', SAFE_PREVIEW_MODE: '1', OR_MISSION_FOLLOW_CAPTURE_ENABLED: '1', OR_MISSION_STAGING_SEND_ENABLED: '1' };
const FOLLOW = { type: 'follow', webhookEventId: 'synthetic-follow-1', timestamp: 1700000000000,
  source: { type: 'user', userId: UID }, follow: { isUnblocked: false } };
function request(event = FOLLOW) {
  const body = JSON.stringify({ destination: 'synthetic-oa', events: [event] });
  return { httpMethod: 'POST', body, headers: { 'x-line-signature': signature(Buffer.from(body), SECRET) } };
}

test('OR mission stays off by default and cannot be activated in production or generic previews', () => {
  assert.equal(stagingCaptureEnabled({}), false);
  assert.equal(stagingCaptureEnabled({ ...ENV, APP_ENV: 'production' }), false);
  assert.equal(stagingCaptureEnabled({ ...ENV, SAFE_PREVIEW_MODE: '0' }), false);
  assert.equal(stagingCaptureEnabled(ENV), true);
});
test('follow normalization preserves unknown/unblock without inferring eligibility; strips tokens and profiles', () => {
  assert.equal(normalizeFollow(FOLLOW).is_unblocked, false);
  assert.equal(normalizeFollow({ ...FOLLOW, follow: { isUnblocked: true } }).is_unblocked, true);
  assert.equal(normalizeFollow({ ...FOLLOW, follow: undefined }).is_unblocked, null);
  assert.equal(normalizeFollow({ ...FOLLOW, type: 'unfollow' }), null);
  assert.equal(normalizeFollow({ ...FOLLOW, timestamp: '1700000000000' }), null);
  assert.equal(normalizeFollow({ ...FOLLOW, source: { type: 'user', userId: 'invalid' } }), null);
  const safe = normalizeFollow({ ...FOLLOW, replyToken: 'must-not-store', profile: 'must-not-store' });
  assert.deepEqual(Object.keys(safe).sort(), ['event_id', 'is_unblocked', 'line_user_id', 'occurred_at']);
});
test('receiver captures in the same SQL statement after signature verification; missing outbox returns 503 before wake', async () => {
  let calls = 0, woke = 0;
  const receive = createReceiver({ channelSecret: SECRET, missionCaptureEnabled: true,
    query: async (sql, params) => {
      calls++; assert.match(sql, /WITH saved_inbox/);
      assert.match(sql, /JOIN saved_inbox/);
      assert.equal(JSON.parse(params[2])[0].line_user_id, UID);
      throw Error('private-db-error');
    }, wake: async () => { woke++; } });
  const bad = request(); bad.headers['x-line-signature'] = 'invalid';
  assert.equal((await receive(bad)).statusCode, 401); assert.equal(calls, 0);
  assert.equal((await receive(request())).statusCode, 503); assert.equal(woke, 0);
});
test('capture-only receiver never makes an HTTP call and disabled receiver never references new schema', async () => {
  let woke = false;
  const enabled = createReceiver({ channelSecret: SECRET, missionCaptureEnabled: true,
    query: async () => ({ rows: [] }), wake: async () => { woke = true; } });
  assert.equal((await enabled(request())).statusCode, 200); assert.equal(woke, true);
  const disabled = createReceiver({ channelSecret: SECRET, query: async sql => {
    assert.doesNotMatch(sql, /or_mission/); return { rows: [] };
  } });
  assert.equal((await disabled(request())).statusCode, 200);
});
test('test request follows Chris parameters, fixes destination and encodes identity', () => {
  const url = new URL(buildStagingRequest(UID));
  assert.equal(url.origin, 'https://staging-api.openrice.com');
  assert.equal(url.pathname, '/v6/api/job/enqueue/user/follow/account');
  assert.deepEqual(Object.fromEntries(url.searchParams), { accountId: '1', accountType: 'openricelinepage', imKey: UID, imTypeId: '130' });
  assert.throws(() => buildStagingRequest('U&redirect=https://elsewhere.invalid'), /invalid/);
});
test('staging sender is off without all gates, and production gate blocks DB and network', async () => {
  const never = async () => { throw Error('must-not-run'); };
  for (const env of [{}, { ...ENV, APP_ENV: 'production' }, { ...ENV, OR_MISSION_STAGING_SEND_ENABLED: '0' }]) {
    assert.equal((await createStagingSender({ query: never, fetchFn: never, env })(1)).status, 'disabled');
  }
});
function fakeStore() {
  let claimed = false;
  const updates = [];
  return { updates, query: async (sql, params) => {
    if (/RETURNING id,line_user_id/.test(sql)) {
      if (claimed) return { rows: [] }; claimed = true;
      return { rows: [{ id: 1, line_user_id: UID }], rowCount: 1 };
    }
    updates.push(params); return { rows: [{ id: 1 }], rowCount: 1 };
  } };
}
test('HTTP 2xx is unverified, not a completed task; concurrent/manual repeat sends only once', async () => {
  const store = fakeStore(); let calls = 0;
  const send = createStagingSender({ ...store, env: ENV, fetchFn: async (url, opts) => {
    calls++; assert.equal(new URL(url).searchParams.get('imKey'), UID);
    assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
    return { status: 200 };
  } });
  const results = await Promise.all([send(1), send(1), send(1)]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'http_accepted_unverified');
  assert.equal(store.updates[0][2], 'awaiting_or_confirmation');
  assert.equal((await send(1)).status, 'not_claimed');
});
test('timeout, rejection and failed record update never blindly retry or leak error detail', async () => {
  for (const outcome of ['timeout', 'rejected', 'db-failure']) {
    const store = fakeStore(); let calls = 0;
    const query = async (sql, p) => {
      if (outcome === 'db-failure' && /SET status=\$2/.test(sql)) throw Error('private-db');
      return store.query(sql, p);
    };
    const send = createStagingSender({ query, env: ENV, fetchFn: async () => {
      calls++; if (outcome === 'timeout') throw Error('secret-and-private-url');
      return { status: outcome === 'rejected' ? 403 : 202 };
    } });
    const result = await send(1);
    assert.equal(result.status, outcome === 'rejected' ? 'http_rejected' : 'uncertain');
    assert.doesNotMatch(JSON.stringify(result), /secret-and|private-db/);
    assert.equal((await send(1)).status, 'not_claimed'); assert.equal(calls, 1);
  }
});

module.exports = {};
