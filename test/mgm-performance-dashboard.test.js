const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const {
  registerMgmMilesRoutes,
  parseReportDateRange,
  MAX_REPORT_RANGE_DAYS
} = require('../src/routes/mgmMiles');

const REPO = path.join(__dirname, '..');

function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.render = () => res;
  res.send = () => res;
  return res;
}

function buildRoutes(query) {
  const routes = {};
  const app = {
    get(route, ...handlers) { routes['GET ' + route] = handlers; },
    post(route, ...handlers) { routes['POST ' + route] = handlers; }
  };
  const pass = (_req, _res, next) => next();
  registerMgmMilesRoutes(app, {
    query,
    authCore: { requireAdmin: pass, requireOwner: pass },
    mgmEngine: {},
    defaultLiffId: '123-test'
  });
  return routes;
}

function buildDataRoute(query) {
  return buildRoutes(query)['GET /admin/mgm/api/data'];
}

async function runHandlers(handlers, query, body = {}) {
  const req = { query, params: {}, body, authUser: { un: 'admin' } };
  const res = makeResponse();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test('活動成效日期使用台灣日界線，並擋下缺日期、反向與過長期間', () => {
  const valid = parseReportDateRange('2026-09-01', '2026-09-08');
  assert.equal(valid.ok, true);
  assert.equal(valid.days, 8);
  assert.equal(valid.startAt, '2026-09-01T00:00:00+08:00');
  assert.equal(valid.endExclusiveAt, '2026-09-09T00:00:00+08:00');
  assert.equal(parseReportDateRange('', '').filtered, false);
  assert.equal(parseReportDateRange('2026-09-01', '').ok, false);
  assert.equal(parseReportDateRange('2026-09-09', '2026-09-08').ok, false);
  assert.equal(parseReportDateRange('2026-02-30', '2026-03-01').ok, false);
  assert.equal(MAX_REPORT_RANGE_DAYS, 366);
  assert.equal(parseReportDateRange('2025-01-01', '2026-09-08').ok, false);
});

test('活動成效 API 把同一期間套到 KPI、邀請、得獎名單與庫存抽出數', async () => {
  const calls = [];
  const replies = [
    { rows: [{ id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active' }] },
    { rows: [{ id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active', rules: {} }] },
    { rows: [{ miles_total: 10000, miles_pending: 10000, wins: 1, wins_pending: 1, plays: 2, people: 2 }] },
    { rows: [{ c: 1, existing: 0, inviters: 1 }] },
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }
  ];
  const handlers = buildDataRoute(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params || [] });
    return replies.shift();
  });
  const res = await runHandlers(handlers, {
    activity_id: '6', from_date: '2026-09-01', to_date: '2026-09-08'
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.report_range, {
    filtered: true, from: '2026-09-01', to: '2026-09-08', days: 8, timezone: 'Asia/Taipei'
  });
  const reportQueries = calls.slice(2);
  assert.equal(reportQueries.length, 7);
  reportQueries.forEach(call => {
    assert.equal(call.params.length, 3);
    assert.equal(call.params[1], '2026-09-01T00:00:00+08:00');
    assert.equal(call.params[2], '2026-09-09T00:00:00+08:00');
    assert.match(call.sql, /(?:played_at|created_at) >= \$2/);
    assert.match(call.sql, /(?:played_at|created_at) < \$3/);
  });
});

test('活動成效 API 遇到不完整日期時先拒絕，不執行報表查詢', async () => {
  let queried = false;
  const handlers = buildDataRoute(async () => { queried = true; return { rows: [] }; });
  const res = await runHandlers(handlers, { from_date: '2026-09-01' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_date_range');
  assert.equal(queried, false);
});

test('從篩選結果建立邀請人名單時沿用同一日期範圍', async () => {
  const calls = [];
  const routes = buildRoutes(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params || [] });
    if (calls.length === 1) {
      return { rows: [{ id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active' }] };
    }
    return { rows: [] };
  });
  const res = await runHandlers(routes['POST /admin/mgm/api/make-list'], {}, {
    segment: 'inviters', activity_id: 6, from_date: '2026-09-01', to_date: '2026-09-08'
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'empty');
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /r\.created_at >= \$2 AND r\.created_at < \$3/);
  assert.deepEqual(calls[1].params, [
    6, '2026-09-01T00:00:00+08:00', '2026-09-09T00:00:00+08:00'
  ]);
});

test('期間內的待發里數名單同時支援新版獎項快照', async () => {
  const calls = [];
  const routes = buildRoutes(async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params || [] });
    if (calls.length === 1) {
      return { rows: [{ id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active' }] };
    }
    return { rows: [] };
  });
  const res = await runHandlers(routes['POST /admin/mgm/api/make-list'], {}, {
    segment: 'pending_miles', activity_id: 6, from_date: '2026-09-01', to_date: '2026-09-08'
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'empty');
  assert.match(calls[1].sql, /prize_snapshot->'prize_value'->>'miles'/);
  assert.match(calls[1].sql, /p\.played_at >= \$2 AND p\.played_at < \$3/);
});

test('活動成效查詢不再使用未分組的 activity_id，並讀得到新版里數欄位', () => {
  const source = fs.readFileSync(path.join(REPO, 'src/routes/mgmMiles.js'), 'utf8');
  assert.doesNotMatch(source, /p2\.activity_id\s*=\s*p\.activity_id/);
  assert.match(source, /prize_snapshot->'prize_value'->>'miles'/);
  assert.match(source, /prize_inventory:\s*prizeInventory/);
  assert.match(source, /COALESCE\(prize_snapshot->>'prize_type',''\) <> 'none'/);
});

test('活動成效頁同頁顯示分享超有哩 KPI、獎項庫存與得獎名單', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_mgm.ejs'), {
    title: '活動成效', user: 'admin', isAdmin: true, bodyClass: 'admin-shell mgm-shell'
  }, { views: [path.join(REPO, 'views')] });

  const payload = {
    ok: true,
    activities: [{ id: 6, name: '分享超有哩', game_type: 'wheel' }],
    activity: {
      id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active',
      base_plays_per_user: 1, referral_bonus_per: 1, referral_invites_per_bonus: 1,
      referral_bonus_max: 3,
      stats: {
        referrals: 4, referrals_existing: 1, inviters: 2, people: 8,
        plays: 12, wins: 7, wins_pending: 3, miles_pending: 20000
      }
    },
    prize_inventory: [
      { id: 18, name: '【三獎】10,000 哩', prize_type: 'badge', stock_total: 11, stock_remaining: 9, drawn: 2, is_grand_prize: true },
      { id: 22, name: '銘謝惠顧', prize_type: 'none', stock_total: null, stock_remaining: null, drawn: 5, is_grand_prize: false }
    ],
    people: [{
      uid: 'U1234567890abcdef', display_name: 'Ice', wins: 2, wins_pending: 1,
      pending_prizes: '【三獎】10,000 哩', miles: 20000, miles_pending: 10000,
      miles_done: 10000, last_at: '2026-09-04T08:00:00Z'
    }],
    ledger: [{
      id: 1, line_user_id: 'U1234567890abcdef', display_name: 'Ice',
      prize_name: '【三獎】10,000 哩', prize_type: 'badge', miles: 10000,
      coupon_code: null, granted_done: false, played_at: '2026-09-04T08:00:00Z'
    }],
    inviters: [{ uid: 'U1234567890abcdef', display_name: 'Ice', new_friends: 4, existing_friends: 1, last_at: '2026-09-04T08:00:00Z' }],
    pairs: [{
      created_at: '2026-09-04T08:00:00Z', inviter_uid: 'U1234567890abcdef', inviter_name: 'Ice',
      invitee_uid: 'Uabcdef1234567890', invitee_name: 'Josh', was_existing: false
    }],
    report_range: { filtered: true, from: '2026-09-01', to: '2026-09-08', days: 8, timezone: 'Asia/Taipei' }
  };

  const fetchedUrls = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin/mgm?activity_id=6&period=custom&from_date=2026-09-01&to_date=2026-09-08',
    beforeParse(window) {
      window.fetch = async url => { fetchedUrls.push(String(url)); return { json: async () => payload }; };
      window.confirm = () => true;
    }
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  const document = dom.window.document;
  assert.equal(document.querySelector('#mg-act option:checked').textContent, '分享超有哩（幸運轉盤）');
  assert.match(document.getElementById('mg-stats').textContent, /成功邀請新好友/);
  assert.match(document.getElementById('mg-stats').textContent, /20,000/);
  assert.equal(document.querySelectorAll('#mg-inventory .mg-prize').length, 2);
  assert.match(document.getElementById('mg-inventory').textContent, /剩餘/);
  assert.match(document.getElementById('mg-inventory').textContent, /設定總量 11/);
  assert.match(document.getElementById('mg-inventory').textContent, /此期間抽出 2/);
  assert.match(document.getElementById('mg-people').textContent, /Ice/);
  assert.match(document.getElementById('mg-people').textContent, /三獎/);
  assert.equal(document.getElementById('mg-range-preset').value, 'custom');
  assert.match(document.getElementById('mg-range-note').textContent, /2026-09-01～2026-09-08/);
  assert.match(fetchedUrls[0], /from_date=2026-09-01/);
  assert.match(fetchedUrls[0], /to_date=2026-09-08/);
  assert.match(document.body.textContent, /完整活動紀錄，不受上方期間篩選影響/);
  assert.match(document.body.textContent, /抽獎池不受上方報表期間影響/);
  dom.window.close();
});
