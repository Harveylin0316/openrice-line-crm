const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
  registerAdminLiffTrackingRoutes,
  cleanHttpsUrl,
  cleanSourceKey,
  reportDays
} = require('../src/routes/adminLiffTracking');

function appStub(routes) {
  return {
    get(pathname, ...handlers) { routes['GET ' + pathname] = handlers; },
    post(pathname, ...handlers) { routes['POST ' + pathname] = handlers; }
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    view: null,
    locals: null,
    redirectTo: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render(view, locals) { this.view = view; this.locals = locals; return this; },
    redirect(code, target) {
      if (typeof target === 'undefined') { target = code; code = 302; }
      this.statusCode = code; this.redirectTo = target; return this;
    },
    setHeader(key, value) { this.headers[key] = value; }
  };
}

async function run(routes, key, req = {}) {
  const res = response();
  const request = {
    query: {}, body: {}, params: {}, authUser: { un: 'admin' },
    ...req
  };
  const handlers = routes[key];
  assert.ok(handlers, 'route exists: ' + key);
  for (const handler of handlers) {
    let continued = false;
    await handler(request, res, () => { continued = true; });
    if (!continued) break;
  }
  return res;
}

const pass = (_req, _res, next) => next();
const uid = 'U' + 'a'.repeat(32);

test('追蹤輸入只接受安全網址、來源代號與合理期間', () => {
  assert.equal(cleanHttpsUrl('https://liff.line.me/123/demo'), 'https://liff.line.me/123/demo');
  assert.equal(cleanHttpsUrl('http://example.com'), '');
  assert.equal(cleanHttpsUrl('https://user:pass@example.com'), '');
  assert.equal(cleanSourceKey('Instagram_Story'), 'instagram_story');
  assert.equal(cleanSourceKey('中文來源'), '');
  assert.equal(reportDays('all'), null);
  assert.equal(reportDays('90'), 90);
  assert.equal(reportDays('9999'), 365);
  assert.equal(reportDays('bad'), 30);
});

test('後台頁面完整呈現設定、成效與手機版介面', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/admin_liff_tracking.ejs'), {
    title: 'LIFF 來源追蹤', bodyClass: 'admin-shell', user: 'Ice', isAdmin: true,
    sourcePresets: [{ value: 'richmenu', label: '圖文選單' }, { value: 'other', label: '其他' }]
  }, { views: [path.join(__dirname, '../views')] });
  assert.match(html, /新增追蹤網址/);
  assert.match(html, /Campaign 名稱/);
  assert.match(html, /不重複用戶/);
  assert.match(html, /來源比較/);
  assert.match(html, /下載 CSV/);
  assert.match(html, /text\/csv;charset=utf-8/);
  assert.match(html, /同一人同一分鐘重複載入只算一次/);
  assert.match(html, /\.topbar\.topbar--admin \.topbar-nav \{ display: none;/);
  assert.match(html, /\.topbar\.topbar--admin \.topbar-nav\.nav-open \{ display: flex;/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.match(html, /@media\(max-width:720px\)/);
  assert.doesNotMatch(html, /undefined/);
});

test('建立活動轉換追蹤網址會驗證活動並保留歸因設定', async () => {
  const oldLiff = process.env.GAMES_LIFF_ID;
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const routes = {};
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (/SELECT id FROM activities/.test(sql)) return { rows: [{ id: 6 }], rowCount: 1 };
    if (/INSERT INTO liff_tracking_links/.test(sql)) return { rows: [{ id: 41 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  registerAdminLiffTrackingRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'POST /admin/liff-tracking/api/links', {
    body: {
      name: '9/15 圖文選單', campaign_name: '分享超有哩',
      source_key: 'richmenu', source_label: '圖文選單',
      target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles',
      conversion_type: 'activity_play', conversion_key: '6', attribution_days: 14
    }
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.tracking_url, 'https://liff.line.me/2000000000-test/lt/41');
  const insert = calls.find(call => /INSERT INTO liff_tracking_links/.test(call.sql));
  assert.deepEqual(insert.params.slice(0, 8), [
    '9/15 圖文選單', '分享超有哩', 'richmenu', '圖文選單',
    'https://liff.line.me/2000000000-test/wheel/share-miles', 'activity_play', '6', 14
  ]);
  if (oldLiff == null) delete process.env.GAMES_LIFF_ID; else process.env.GAMES_LIFF_ID = oldLiff;
});

test('公開網址以 LIFF 驗證身分、同分鐘去重，而且暫停不擋跳轉', async () => {
  const oldLiff = process.env.GAMES_LIFF_ID;
  const oldUrl = process.env.PUBLIC_SITE_URL;
  const oldOa = process.env.LINE_OFFICIAL_ADD_FRIEND_URL;
  process.env.GAMES_LIFF_ID = '2000000000-test';
  process.env.PUBLIC_SITE_URL = 'https://crm.example.com';
  process.env.LINE_OFFICIAL_ADD_FRIEND_URL = 'https://line.me/R/ti/p/@openrice';
  const routes = {};
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (/SELECT id, target_url/.test(sql)) {
      return { rows: [{ id: 41, target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles?x=1' }], rowCount: 1 };
    }
    if (/SELECT id, status/.test(sql)) return { rows: [{ id: 41, status: 'active' }], rowCount: 1 };
    if (/INSERT INTO liff_tracking_events/.test(sql)) return { rows: [{ id: 9 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  registerAdminLiffTrackingRoutes(appStub(routes), {
    query, authCore: { requireAdmin: pass },
    verifyLiffIdToken: async () => ({ ok: true, sub: uid })
  });
  const bounce = await run(routes, 'GET /games/lt/:id(\\d+)', { params: { id: '41' } });
  assert.equal(bounce.view, 'tap_bounce');
  assert.equal(bounce.locals.target, 'https://crm.example.com/games/wheel/share-miles?x=1');
  assert.equal(bounce.locals.recordUrl, '/lt/41/hit');
  assert.equal(bounce.locals.externalLiffUrl, 'https://liff.line.me/2000000000-test/lt/41');
  assert.equal(bounce.locals.externalLineUrl, 'https://line.me/R/ti/p/@openrice');
  assert.equal(bounce.locals.externalActivityLabel, '分享超有哩');
  const hit = await run(routes, 'POST /lt/:id(\\d+)/hit', { params: { id: '41' }, body: { id_token: 'valid' } });
  assert.equal(hit.body.ok, true);
  assert.equal(hit.body.recorded, true);
  const insert = calls.find(call => /INSERT INTO liff_tracking_events/.test(call.sql));
  assert.deepEqual(insert.params, [41, uid]);
  assert.match(insert.sql, /ON CONFLICT/);
  if (oldLiff == null) delete process.env.GAMES_LIFF_ID; else process.env.GAMES_LIFF_ID = oldLiff;
  if (oldUrl == null) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = oldUrl;
  if (oldOa == null) delete process.env.LINE_OFFICIAL_ADD_FRIEND_URL; else process.env.LINE_OFFICIAL_ADD_FRIEND_URL = oldOa;
});

test('成效 API 同步套用期間並計算開啟、來源與轉換率', async () => {
  const oldLiff = process.env.GAMES_LIFF_ID;
  process.env.GAMES_LIFF_ID = '2000000000-test';
  const routes = {};
  const calls = [];
  const query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT l\.id, l\.name/.test(text)) return { rows: [{
      id: 41, name: '圖文選單', campaign_name: '分享超有哩', source_key: 'richmenu', source_label: '圖文選單',
      target_url: 'https://example.com', conversion_type: 'activity_play', conversion_key: '6', attribution_days: 7,
      status: 'active', opens: 3, unique_users: 2, last_opened_at: '2026-09-09T01:00:00Z'
    }] };
    if (/SELECT id, name, slug FROM activities/.test(text)) return { rows: [{ id: 6, name: '分享超有哩', slug: 'share-miles' }] };
    if (/SELECT event_name, COUNT/.test(text)) return { rows: [] };
    if (/SELECT COUNT\(\*\)::int AS opens, COUNT\(DISTINCT line_user_id\)/.test(text)) return { rows: [{ opens: 3, unique_users: 2, active_links: 1 }] };
    if (/SELECT l\.source_key/.test(text)) return { rows: [{ source_key: 'richmenu', source_label: '圖文選單', opens: 3, unique_users: 2 }] };
    if (/to_char\(date_trunc\('day'/.test(text)) return { rows: [{ day: '2026-09-09', opens: 3, unique_users: 2 }] };
    if (/conversion_type='activity_play'/.test(text)) return { rows: [{ id: 41, conversions: 1 }] };
    if (/conversion_type='user_event'/.test(text)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  registerAdminLiffTrackingRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'GET /admin/liff-tracking/api/data', { query: { days: '90' } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.days, 90);
  assert.deepEqual(res.body.summary, { opens: 3, unique_users: 2, active_links: 1, conversions: 1 });
  assert.equal(res.body.links[0].conversion_rate_pct, 50);
  assert.equal(res.body.links[0].conversion_label, '玩過「分享超有哩」');
  assert.ok(calls.filter(call => call.params && call.params[0] === '90').length >= 6);
  if (oldLiff == null) delete process.env.GAMES_LIFF_ID; else process.env.GAMES_LIFF_ID = oldLiff;
});

test('暫停追蹤只更新狀態，不刪除網址或歷史', async () => {
  const routes = {};
  let updateCall;
  const query = async (sql, params) => {
    if (/UPDATE liff_tracking_links/.test(sql)) {
      updateCall = { sql: String(sql), params };
      return { rows: [{ id: 41, status: 'paused' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  registerAdminLiffTrackingRoutes(appStub(routes), { query, authCore: { requireAdmin: pass } });
  const res = await run(routes, 'POST /admin/liff-tracking/api/links/:id(\\d+)/status', {
    params: { id: '41' }, body: { status: 'paused' }
  });
  assert.equal(res.body.ok, true);
  assert.deepEqual(updateCall.params, [41, 'paused']);
  assert.doesNotMatch(updateCall.sql, /DELETE/i);
});
