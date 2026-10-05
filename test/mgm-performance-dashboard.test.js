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

function buildRoutes(query, authOverrides = {}) {
  const routes = {};
  const app = {
    get(route, ...handlers) { routes['GET ' + route] = handlers; },
    post(route, ...handlers) { routes['POST ' + route] = handlers; }
  };
  const pass = (_req, _res, next) => next();
  registerMgmMilesRoutes(app, {
    query,
    authCore: { requireAdmin: pass, requireOwner: pass, ...authOverrides },
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
    { rows: [{ c: 1, existing: 0, unknown: 0, inviters: 1 }] },
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    { rows: [{ confirmed_new_friends: 1, calculated_bonus_chances: 1,
      confirmed_attempts_without_referral: 0, review_candidates: 0,
      potential_extra_chances: 0, candidates: [] }] },
    { rows: [] },
    { rows: [{ total: 1, historical_count: 1, pending_count: 0, candidates: [] }] }
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
  const reportQueries = calls.slice(2, 10);
  assert.equal(reportQueries.length, 8);
  reportQueries.filter((_, i) => i !== 6).forEach(call => {
    assert.equal(call.params.length, 3);
    assert.equal(call.params[1], '2026-09-01T00:00:00+08:00');
    assert.equal(call.params[2], '2026-09-09T00:00:00+08:00');
    assert.match(call.sql, /(?:played_at|created_at) >= \$2/);
    assert.match(call.sql, /(?:played_at|created_at) < \$3/);
  });
  assert.match(reportQueries[1].sql, /COUNT\(DISTINCT inviter_line_user_id\) FILTER \(WHERE invitee_was_existing IS FALSE\)/);
  assert.match(reportQueries[4].sql, /HAVING COUNT\(\*\) FILTER \(WHERE r\.invitee_was_existing IS FALSE\) > 0/);
  assert.match(reportQueries[1].sql, /invitee_was_existing IS TRUE/);
  assert.match(reportQueries[1].sql, /invitee_was_existing IS NULL/);
  assert.doesNotMatch(reportQueries[1].sql, /IS NOT FALSE/);
  assert.deepEqual(reportQueries[6].params, [6, 'share-miles', 0, 1, 0]);
  assert.deepEqual(calls[10].params, [6, 'share-miles', 'wheel']);
  assert.equal(res.body.referral_review.historical_count, 1);
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
        referrals: 4, referrals_existing: 1, referrals_unknown: 1, inviters: 2, people: 8,
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
    inviters: [{ uid: 'U1234567890abcdef', display_name: 'Ice', new_friends: 4, existing_friends: 1, unknown_friends: 1, last_at: '2026-09-04T08:00:00Z' }],
    pairs: [{
      created_at: '2026-09-04T08:00:00Z', inviter_uid: 'U1234567890abcdef', inviter_name: 'Ice',
      invitee_uid: 'Uabcdef1234567890', invitee_name: 'Josh', was_existing: false
    }, {
      created_at: '2026-09-04T09:00:00Z', inviter_uid: 'U1234567890abcdef', inviter_name: 'Ice',
      invitee_uid: 'U0000000000000000', invitee_name: 'Unknown', was_existing: null
    }],
    referral_audit: {
      confirmed_new_friends: 4, calculated_bonus_chances: 3,
      confirmed_attempts_without_referral: 0, review_candidates: 1,
      potential_extra_chances: 0,
      candidates: [{
        attempted_at: '2026-08-18T04:50:55Z', inviter_uid: 'U1234567890abcdef', inviter_name: 'Ice',
        invitee_uid: 'Uabcdef1234567890', invitee_name: 'Josh', current_new_friends: 4,
        extra_chances_if_confirmed: 0
      }]
    },
    referral_review: { total: 1, historical_count: 1, pending_count: 0, candidates: [{
      referral_id: 12, attempted_at: '2026-09-04T08:00:03Z',
      inviter_uid: 'U11111111111111111111111111111111', inviter_name: '  =1+1',
      invitee_uid: 'U22222222222222222222222222222222', invitee_name: '<img src=x onerror=alert(1)>',
      first_seen_at: '2026-09-04T07:59:59Z', followed_at: '2026-09-04T08:00:01Z', reason: 'legacy_existing'
    }] },
    report_range: { filtered: true, from: '2026-09-01', to: '2026-09-08', days: 8, timezone: 'Asia/Taipei' }
  };

  const fetchedUrls = [];
  const downloads = [];
  let fetchOverride;

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin/mgm?activity_id=6&period=custom&from_date=2026-09-01&to_date=2026-09-08',
    beforeParse(window) {
      window.fetch = async url => {
        fetchedUrls.push(String(url));
        if(String(url).includes('/referral-decisions'))return {json:async()=>({ok:true,
          counts:{needs_repair:0,no_action:0,insufficient:1},candidates:fetchOverride?[]:
            payload.referral_review.candidates.map(r=>({...r,decision:'insufficient',repairable:false,explanation:'歷史證據不足，非確認漏發'}))})};
        return fetchOverride ? fetchOverride(url) : { json: async () => payload };
      };
      window.confirm = () => true;
      window.Blob = class { constructor(parts) { this.text = parts.join(''); } };
      window.URL.createObjectURL = blob => { downloads.push(blob.text); return 'blob:fixture'; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = () => {};
    }
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  const document = dom.window.document;
  assert.equal(document.querySelector('#mg-act option:checked').textContent, '分享超有哩（幸運轉盤）');
  assert.match(document.getElementById('mg-stats').textContent, /成功邀請新好友/);
  assert.match(document.getElementById('mg-stats').textContent, /成功邀請的會員/);
  assert.match(document.getElementById('mg-stats').textContent, /好友狀態不明/);
  assert.match(document.getElementById('mg-ref-audit').textContent, /已入帳的新好友次數對帳未發現缺口/);
  assert.match(document.getElementById('mg-ref-audit').textContent, /不表示所有歷史邀請都正確/);
  assert.match(document.getElementById('mg-pairs').textContent, /好友狀態不明/);
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
  assert.equal(document.querySelectorAll('#mg-ref-review img').length, 0);
  document.getElementById('mg-review-csv').click();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].charCodeAt(0), 0xfeff);
  assert.match(downloads[0], /U22222222222222222222222222222222/);
  assert.match(downloads[0], /16:00:03/);
  assert.match(downloads[0], /"'  =1\+1"/);
  assert.match(downloads[0], /非確認漏發/);
  // 快速切換時，較晚回來的舊查詢不能覆蓋新的清單或重新開啟匯出。
  const pending = [];
  fetchOverride = () => new Promise(resolve => pending.push(resolve));
  document.getElementById('mg-range-apply').click();
  document.getElementById('mg-range-apply').click();
  assert.equal(pending.length, 2);
  pending[1]({ json: async () => ({ ...payload, referral_review: { total: 0, candidates: [] } }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  pending[0]({ json: async () => payload });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.getElementById('mg-review-csv').disabled, true);
  assert.doesNotMatch(document.getElementById('mg-ref-review').textContent, /=1\+1/);
  fetchOverride = async () => { throw new Error('fixture offline'); };
  document.getElementById('mg-range-apply').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.getElementById('mg-review-csv').disabled, true);
  assert.match(document.getElementById('mg-ref-review').textContent, /不能下載舊資料/);
  dom.window.close();
});

test('邀請判斷畫面只開放有證據的修正、確認可取消、重複點擊只發一次', async () => {
  const html=await ejs.renderFile(path.join(REPO,'views/admin_mgm.ejs'),{
    title:'QA',user:'admin',isAdmin:true,bodyClass:'admin-shell mgm-shell'
  },{views:[path.join(REPO,'views')]});
  const data={ok:true,activity:{id:6,name:'QA',game_type:'wheel',stats:{}},activities:[],
    prize_inventory:[],people:[],ledger:[],inviters:[],pairs:[],referral_audit:{}};
  const candidates=['needs_repair','insufficient','no_action'].map((decision,i)=>({
    decision,repairable:i===0,extra_chances:i===0?1:0,explanation:i===1?'歷史證據不足':'QA 理由',
    inviter_name:'QA inviter',invitee_name:'QA invitee',inviter_uid:'U'+'a'.repeat(32),
    invitee_uid:'U'+String(i+1).repeat(32),attempted_at:'2026-10-05T09:00:00Z'}));
  let confirm=false,resolveRepair,posts=0,body;
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://example.test/admin/mgm',beforeParse(w){
    w.confirm=()=>confirm;w.alert=()=>{};
    w.fetch=async (url,options)=>{
      if(String(url).includes('/repair-referral')){posts++;body=JSON.parse(options.body);return new Promise(r=>{resolveRepair=r;});}
      return {json:async()=>String(url).includes('/referral-decisions')?
        {ok:true,candidates,counts:{needs_repair:1,insufficient:1,no_action:1}}:data};
    };
  }});
  await new Promise(r=>setTimeout(r,40));
  const doc=dom.window.document;
  assert.equal(doc.querySelectorAll('[data-ref-repair]').length,1);
  doc.querySelector('[data-ref-repair]').click();assert.equal(posts,0);
  confirm=true;doc.querySelector('[data-ref-repair]').click();
  doc.querySelector('[data-ref-repair]').click();assert.equal(posts,1);
  assert.equal(body.confirm,true);assert.equal(body.activity_id,6);
  assert.equal(body.plays,undefined);assert.equal(body.extra_chances,undefined);
  assert.equal(doc.querySelector('[data-ref-repair]').disabled,true);
  resolveRepair({json:async()=>({ok:true})});await new Promise(r=>setTimeout(r,40));
  const filter=doc.getElementById('mg-decision-filter');filter.value='insufficient';
  filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(doc.querySelectorAll('[data-ref-repair]').length,0);
  assert.match(doc.getElementById('mg-ref-review').textContent,/歷史證據不足/);
  dom.window.close();
});

test('邀請修正 API 拒絕未確認、跨來源與沒有交易連線，不能落回非交易 query', async()=>{
  let reads=0;const routes=buildRoutes(async()=>{reads++;return {rows:[]};});
  const handlers=routes['POST /admin/mgm/api/repair-referral'];
  assert.equal((await runHandlers(handlers,{},{})).statusCode,400);
  const req={body:{activity_id:6,inviter_uid:'U'+'a'.repeat(32),invitee_uid:'U'+'b'.repeat(32),confirm:true},
    get:name=>({origin:'https://evil.test',host:'example.test'})[name]};
  const res=makeResponse();await handlers.at(-1)(req,res);
  assert.equal(res.statusCode,403);
  assert.equal((await runHandlers(handlers,{},req.body)).statusCode,503);
  assert.equal(reads,0);
});

test('邀請修正必須通過管理員角色 gate，staff 不可改判獎勵資格',async()=>{
  let reads=0;
  const routes=buildRoutes(async()=>{reads++;return {rows:[]};},{requireOwner:(_req,res)=>res.status(403).json({ok:false,error:'forbidden'})});
  const res=await runHandlers(routes['POST /admin/mgm/api/repair-referral'],{},
    {activity_id:6,inviter_uid:'U'+'a'.repeat(32),invitee_uid:'U'+'b'.repeat(32),confirm:true});
  assert.equal(res.statusCode,403);assert.equal(reads,0);
});
