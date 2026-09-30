'use strict';
// 玩家數據時間篩選：預設全部期間（原本的畫面）；選了範圍後總覽、開啟成效、抽獎次數分布、
// 玩家清單、建名單全部只算那段台北曆日；剩餘次數仍以整檔活動計算。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { registerAdminActivitiesRoutes } = require('../src/routes/adminActivities');
const { loadActivityFunnel } = require('../src/core/activityFunnel');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

function routes(queryImpl) {
  const out = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { out[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  const client = { query: async (sql, params) => (/INSERT INTO admin_recipient_lists/.test(sql) ? { rows: [{ id: 5, name: params[0], total: params[2] }] } : { rows: [] }), release() {} };
  registerAdminActivitiesRoutes(app, { query: queryImpl, pool: { connect: async () => client }, authCore: { requireAdmin: (_q, _s, n) => n(), requireOwner: (_q, _s, n) => n() } });
  return out;
}
function res() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
const last = h => h[h.length - 1];

test('玩家數據 API：沒給日期＝全部期間，每個查詢的日期參數都是 null', async () => {
  const seen = [];
  const r = routes(async (sql, params) => { seen.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return { rows: [] }; });
  const out = res();
  await last(r['GET /admin/activities/api/:id(\\d+)/players'])({ params: { id: '6' }, query: {} }, out);
  assert.equal(out.body.ok, true, JSON.stringify(out.body));
  assert.deepEqual(out.body.range, { from: null, to: null });
  const list = seen.find(s => /GROUP BY pl.line_user_id, q.max_plays_override/.test(s.sql));
  assert.deepEqual(list.params.slice(2), [null, null]);
  assert.ok(seen.some(s => /FROM activity_user_quotas q/.test(s.sql)), '全部期間仍列出「有配額但沒玩過」的人');
});

test('玩家數據 API：給日期範圍時所有區塊都套台北曆日，剩餘次數用 plays_all 算', async () => {
  const seen = [];
  const r = routes(async (sql, params) => {
    const c = String(sql).replace(/\s+/g, ' ');
    seen.push({ sql: c, params });
    if (/GROUP BY pl.line_user_id, q.max_plays_override/.test(c)) {
      return { rows: [{ line_user_id: 'U1', plays: 1, plays_all: 3, wins: 0, grand_wins: 0, referrals: 0, manual_bonus: 0, max_plays_override: null }] };
    }
    if (/SELECT base_plays_per_user, referral_bonus_per/.test(c)) return { rows: [{ base_plays_per_user: 4, referral_bonus_per: 0, referral_bonus_max: 0, referral_invites_per_bonus: 1 }] };
    return { rows: [] };
  });
  const out = res();
  await last(r['GET /admin/activities/api/:id(\\d+)/players'])({ params: { id: '6' }, query: { from: '2026-09-01', to: '2026-09-07' } }, out);
  assert.equal(out.body.ok, true, JSON.stringify(out.body));
  assert.deepEqual(out.body.range, { from: '2026-09-01', to: '2026-09-07' });
  const list = seen.find(s => /GROUP BY pl.line_user_id, q.max_plays_override/.test(s.sql));
  assert.match(list.sql, /AT TIME ZONE 'Asia\/Taipei'/);
  assert.match(list.sql, /::date \+ 1/);
  assert.deepEqual(list.params, [6, 200, '2026-09-01', '2026-09-07']);
  const ov = seen.find(s => /AS total_plays/.test(s.sql));
  assert.deepEqual(ov.params, [6, '2026-09-01', '2026-09-07']);
  const dist = seen.find(s => /AS plays, COUNT\(\*\)::int AS users/.test(s.sql));
  assert.deepEqual(dist.params, [6, '2026-09-01', '2026-09-07']);
  assert.ok(seen.some(s => /FROM activity_user_events/.test(s.sql) && s.params[1] === '2026-09-01'), '開啟成效也套範圍');
  assert.ok(!seen.some(s => /FROM activity_user_quotas q/.test(s.sql)), '有範圍時不列沒玩過的人');
  // 範圍內玩 1 次、整檔已玩 3 次、基礎 4 次 → 剩 1 次
  assert.equal(out.body.players[0].plays, 1);
  assert.equal(out.body.players[0].quota_remaining, 1);
});

test('玩家數據 API：日期格式錯或起訖顛倒回 400', async () => {
  const r = routes(async () => ({ rows: [] }));
  const bad = res();
  await last(r['GET /admin/activities/api/:id(\\d+)/players'])({ params: { id: '6' }, query: { from: '2026/09/01' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_date');
  const swapped = res();
  await last(r['GET /admin/activities/api/:id(\\d+)/players'])({ params: { id: '6' }, query: { from: '2026-09-10', to: '2026-09-01' } }, swapped);
  assert.equal(swapped.body.error, 'invalid_range');
  const fake = res();
  await last(r['GET /admin/activities/api/:id(\\d+)/players'])({ params: { id: '6' }, query: { from: '2026-02-30' } }, fake);
  assert.equal(fake.body.error, 'invalid_date');
});

test('建名單會帶畫面上的日期範圍', async () => {
  const seen = [];
  const r = routes(async (sql, params) => { seen.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return { rows: [{ line_user_id: 'U' + 'c'.repeat(32) }] }; });
  const out = res();
  await last(r['POST /admin/activities/api/:id(\\d+)/export-players-to-list'])({
    params: { id: '6' }, authUser: { un: 'admin' },
    body: { name: '近7天 1 抽', filter: 'plays_eq', plays: 1, from: '2026-09-18', to: '2026-09-24' }
  }, out);
  assert.equal(out.body.ok, true, JSON.stringify(out.body));
  assert.deepEqual(seen[0].params, [6, '2026-09-18', '2026-09-24', 1]);
  const winners = res();
  await last(r['POST /admin/activities/api/:id(\\d+)/export-players-to-list'])({
    params: { id: '6' }, authUser: { un: 'admin' }, body: { name: 'w', filter: 'winners', from: '2026-09-18' }
  }, winners);
  assert.match(seen[1].sql, /prize_id IS NOT NULL AND/);
  assert.deepEqual(seen[1].params, [6, '2026-09-18', null]);
});

test('開啟成效：有範圍時查範圍內並回傳 ranged；沒範圍維持原本查詢', async () => {
  const calls = [];
  const q = async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return { rows: [] }; };
  const f = await loadActivityFunnel(q, 6, { from: '2026-09-01', to: '2026-09-02' });
  assert.equal(f.ranged, true);
  assert.deepEqual(calls[0].params, [6, '2026-09-01', '2026-09-02']);
  calls.length = 0;
  const g = await loadActivityFunnel(q, 6, null);
  assert.equal(g.ranged, undefined);
  assert.deepEqual(calls[0].params, [6]);
});

async function openPage(url) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_players.ejs'), {
    title: '玩家', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activity: { id: 6, name: '分享超有哩', game_type: 'wheel', base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3 }
  }, { views: [path.join(REPO, 'views')] });
  const gets = [];
  const posts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url,
    beforeParse(window) {
      window.prompt = (_m, d) => d;
      window.alert = () => {};
      window.fetch = async (u, opts) => {
        if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true, list: { id: 3 }, total: 2 }) }; }
        if (/\/testers/.test(u)) return { json: async () => ({ ok: true, testers: [] }) };
        gets.push(u);
        return { json: async () => ({ ok: true, players: [], overview: { total_plays: 9 }, funnel: null, grants: null, play_distribution: [{ plays: 1, users: 2 }] }) };
      };
    }
  });
  await wait(80);
  return { dom, doc: dom.window.document, window: dom.window, gets, posts };
}

test('頁面：預設全部期間（與原本相同的請求），點「近 7 天」重新載入並把範圍寫進網址', async () => {
  const { dom, doc, window, gets, posts } = await openPage('https://example.test/admin/activities/6/players');
  assert.equal(gets[0], '/admin/activities/api/6/players');
  assert.equal(doc.querySelector('[data-range="all"]').classList.contains('active'), true);
  assert.match(doc.getElementById('date-filter-note').textContent, /全部期間/);
  assert.equal(doc.getElementById('ov-plays-k').textContent, '總抽次');

  doc.querySelector('[data-range="7d"]').click();
  await wait(40);
  const lastGet = gets[gets.length - 1];
  const m = /from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(lastGet);
  assert.ok(m, lastGet);
  const days = (new Date(m[2]) - new Date(m[1])) / 86400000;
  assert.equal(days, 6, '近 7 天含今天');
  assert.match(window.location.search, /from=.+&to=/);
  assert.equal(doc.getElementById('ov-plays-k').textContent, '期間抽次');

  doc.querySelector('.play-dist-cell button').click();
  await wait(30);
  assert.equal(posts[0].from, m[1]);
  assert.equal(posts[0].to, m[2]);
  assert.match(posts[0].name, /～/);
  dom.window.close();
});

test('頁面：網址帶自訂範圍會直接套用，自訂可改日期再套用', async () => {
  const { dom, doc, gets } = await openPage('https://example.test/admin/activities/6/players?from=2026-09-01&to=2026-09-15');
  assert.equal(gets.length, 1, '初次只載入一次');
  assert.equal(gets[0], '/admin/activities/api/6/players?from=2026-09-01&to=2026-09-15');
  assert.equal(doc.querySelector('[data-range="custom"]').classList.contains('active'), true);
  assert.equal(doc.getElementById('date-filter-custom').hidden, false);
  assert.equal(doc.getElementById('df-from').value, '2026-09-01');
  doc.getElementById('df-to').value = '2026-09-10';
  doc.getElementById('df-apply').click();
  await wait(30);
  assert.equal(gets[gets.length - 1], '/admin/activities/api/6/players?from=2026-09-01&to=2026-09-10');
  doc.querySelector('[data-range="all"]').click();
  await wait(30);
  assert.equal(gets[gets.length - 1], '/admin/activities/api/6/players');
  dom.window.close();
});
