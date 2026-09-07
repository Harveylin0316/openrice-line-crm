const test = require('node:test');
const assert = require('node:assert/strict');
const { registerGameType } = require('../src/routes/gamesGeneric');

function makeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('CRM 內建活動載入 meta 後，以 LINE 驗證身分觸發活動開啟流程', async () => {
  const routes = {};
  const app = {
    get(path, handler) { routes['GET ' + path] = handler; },
    post() {}
  };
  const triggered = [];
  const query = async sql => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/SELECT liff_id_override FROM activities/.test(q)) return { rows: [{ liff_id_override: null }], rowCount: 1 };
    if (/INSERT INTO liff_token_probe/.test(q)) return { rows: [], rowCount: 1 };
    if (/SELECT id, slug, name, description, status/.test(q)) return { rows: [{
      id: 6, slug: 'share-miles', name: '分享超有哩', description: '', status: 'active',
      start_at: null, end_at: null, cover_image_url: null, daily_plays_per_user: null,
      require_follow_oa: true, base_plays_per_user: 1, referral_bonus_per: 1,
      referral_bonus_max: 3, referral_invites_per_bonus: 1
    }], rowCount: 1 };
    if (/FROM activity_prizes/.test(q)) return { rows: [], rowCount: 0 };
    if (/FROM activity_user_quotas/.test(q)) return { rows: [], rowCount: 0 };
    if (/SELECT COUNT\(\*\) AS c FROM activity_plays/.test(q)) return { rows: [{ c: 0 }], rowCount: 1 };
    if (/FROM activity_referrals/.test(q)) return { rows: [{ c: 0, existing: 0 }], rowCount: 1 };
    if (/FROM activity_bonus_plays/.test(q)) return { rows: [{ b: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    json: async () => ({ sub: 'U' + 'f'.repeat(32), aud: '2000000000' }),
    text: async () => '{}'
  });
  try {
    registerGameType(app, {
      query, pool: {},
      flowEngine: { triggerCampaignOpenByActivity: async x => { triggered.push(x); } }
    }, { gameType: 'wheel', viewName: 'game_wheel', defaultLiffId: '2000000000-test' });
    const res = makeRes();
    await routes['GET /api/games/wheel/:slug/meta']({
      params: { slug: 'share-miles' }, query: { line_user_id: 'U' + 'f'.repeat(32) },
      headers: { authorization: 'Bearer valid-token' }
    }, res);
    assert.equal(res.body.ok, true);
    assert.deepEqual(triggered, [{ activityId: 6, lineUserId: 'U' + 'f'.repeat(32) }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('安全預覽不會觸發正式自動化', async () => {
  const routes = {};
  const app = { get(path, handler) { routes['GET ' + path] = handler; }, post() {} };
  const triggered = [];
  const query = async sql => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/SELECT liff_id_override FROM activities/.test(q)) return { rows: [{ liff_id_override: null }], rowCount: 1 };
    if (/INSERT INTO liff_token_probe/.test(q)) return { rows: [], rowCount: 1 };
    if (/SELECT id, slug, name, description, status/.test(q)) return { rows: [{ id: 6, slug: 'share-miles',
      name: '分享超有哩', status: 'active', base_plays_per_user: 1 }], rowCount: 1 };
    if (/FROM activity_prizes/.test(q)) return { rows: [], rowCount: 0 };
    if (/FROM activity_user_quotas/.test(q)) return { rows: [], rowCount: 0 };
    if (/FROM activity_plays/.test(q)) return { rows: [{ c: 0 }], rowCount: 1 };
    if (/FROM activity_referrals/.test(q)) return { rows: [{ c: 0, existing: 0 }], rowCount: 1 };
    if (/FROM activity_bonus_plays/.test(q)) return { rows: [{ b: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({ sub: 'U' + 'e'.repeat(32) }), text: async () => '{}' });
  try {
    registerGameType(app, { query, pool: {}, flowEngine: { triggerCampaignOpenByActivity: async x => triggered.push(x) } },
      { gameType: 'wheel', viewName: 'game_wheel', defaultLiffId: '2000000000-test' });
    const res = makeRes();
    await routes['GET /api/games/wheel/:slug/meta']({
      params: { slug: 'share-miles' }, query: { line_user_id: 'U' + 'e'.repeat(32), preview: '1' },
      headers: { authorization: 'Bearer valid-token' }
    }, res);
    assert.equal(res.body.ok, true);
    assert.equal(triggered.length, 0);
  } finally { global.fetch = originalFetch; }
});
