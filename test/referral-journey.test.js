const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createReferralJourney, claimReferralJourney, detectJourneyExisting } = require('../src/core/referralJourney');
const { registerReferral } = require('../src/core/gamePlayEngine');
const { registerGameType, buildOpenInLineUrl } = require('../src/routes/gamesGeneric');
const { completePendingActivityReferralsForFollow } = require('../src/core/activityReferralFollow');
const INVITER = 'U' + 'a'.repeat(32), INVITEE = 'U' + 'b'.repeat(32);
const PROOF = '123.' + 'x'.repeat(43);
const START = '2026-10-01T08:00:00.000Z';
const source = fs.readFileSync(path.join(__dirname, '../public/games-mgm.js'), 'utf8');

test('入口只存雜湊，不保存可重放的 nonce；未登入不綁定 invitee', async () => {
  let params;
  const proof = await createReferralJourney({ query: async (sql, p) => {
    assert.match(sql, /NULL/); params = p; return { rows: [{ id: '123' }] };
  }, slug: 'share-miles', gameType: 'wheel', inviterId: INVITER });
  assert.match(proof, /^123\.[A-Za-z0-9_-]{43}$/);
  assert.match(params[3], /^journey_open:[a-f0-9]{64}$/);
  assert.ok(!params[3].includes(proof.split('.')[1]));
});

test('旅程 claim 同時核對 nonce、活動、類型、邀請人、72h 與已綁定用戶', async () => {
  const base = { slug: 'share-miles', gameType: 'wheel', inviterId: INVITER, inviteeId: INVITEE };
  let queries = 0;
  const query = async (sql, params) => {
    queries++;
    assert.match(sql, /UPDATE activity_referral_attempts/);
    assert.match(sql, /invitee_line_user_id IS NULL OR invitee_line_user_id = \$5/);
    assert.match(sql, /created_at >= now\(\)/);
    assert.match(sql, /AND created_at <= now\(\)/);
    assert.match(sql, /LEAST\(created_at, \(SELECT MIN\(j.created_at\)/);
    assert.match(sql, /j.inviter_line_user_id=\$6/);
    assert.deepEqual(params.slice(2), ['share-miles', 'wheel', INVITEE, INVITER, 72]);
    return { rows: [{ created_at: START }] };
  };
  assert.equal(await claimReferralJourney({ query, proof: PROOF, ...base }), START);
  assert.equal(await claimReferralJourney({ query, proof: '123.bad', ...base }), null);
  assert.equal(queries, 1);
  assert.equal(await claimReferralJourney({ query: async () => ({ rows: [] }), proof: PROOF, ...base }), null);
});

test('新版判定交叉檢查舊會員、早期好友事件與簽章 follow；不把缺證據當新好友', async () => {
  const query = async (sql, params) => {
    assert.match(sql, /event_timestamp < \$2/);
    assert.match(sql, /first_seen_at FROM member\) < \$2/);
    assert.match(sql, /unblocked = 'true'/);
    assert.match(sql, /unblocked = 'false'/);
    assert.match(sql, /ELSE NULL/);
    assert.doesNotMatch(sql, /archived_at IS NULL/);
    assert.deepEqual(params, [INVITEE, START, '2026-10-01T08:00:02Z', 'false']);
    return { rows: [{ was_existing: false }] };
  };
  assert.equal(await detectJourneyExisting({ query, inviteeId: INVITEE, startedAt: START,
    followEvidence: { at: '2026-10-01T08:00:02Z', isUnblocked: false } }), false);
  assert.equal(await detectJourneyExisting({ query: async () => ({ rows: [{ was_existing: null }] }), inviteeId: INVITEE, startedAt: START }), null);
});

function routes(query) {
  const saved = {};
  registerGameType({ get(p, ...h) { saved['GET ' + p] = h; }, post(p, ...h) { saved['POST ' + p] = h; } },
    { query }, { gameType: 'wheel', viewName: 'game_wheel', defaultLiffId: '2000000000-test' });
  return saved;
}
function res() {
  return { code: 200, headers: {}, status(n) { this.code=n;return this; }, type() { return this; },
    setHeader(k,v) { this.headers[k]=v; }, send(v) { this.body=v;return this; }, json(v) { this.body=v;return this; },
    redirect(n,v) { this.code=n;this.url=v;return this; } };
}

test('新分享入口先記錄再轉 LINE；無效 ref 與非會員不寫入旅程', async () => {
  let writes=0;
  const handlers = routes(async (sql) => {
    if (/FROM activities/.test(sql)) return { rows: [{ slug:'share-miles', game_type:'wheel', status:'active',referral_bonus_per:1 }] };
    if (/FROM users/.test(sql)) return { rows: [{}] };
    if (/INSERT INTO activity_referral_attempts/.test(sql)) { writes++;return { rows:[{id:123}] }; }
    throw Error('Unexpected SQL');
  });
  const handler = handlers['GET /invite/wheel/:slug'].at(-1);
  const valid=res(); await handler({params:{slug:'share-miles'},query:{ref:INVITER}},valid);
  assert.equal(valid.code,302);assert.equal(valid.headers['Cache-Control'],'no-store');
  assert.match(valid.url,new RegExp('^https://liff.line.me/2000000000-test/wheel/share-miles\\?ref='+INVITER+'&journey=123\\.'));
  const invalid=res();await handler({params:{slug:'share-miles'},query:{ref:'https://evil.test'}},invalid);
  assert.equal(invalid.code,400);assert.equal(writes,1);
  const missing=res();await routes(async () => ({rows:[]}))['GET /invite/wheel/:slug'].at(-1)({params:{slug:'no'},query:{ref:INVITER}},missing);
  assert.equal(missing.code,404);
});

test('真 serverless-http 缺 socket IP 不回 500，CDN IP 分流且保留 60 次限制', async () => {
  const express = require('express'), serverless = require('serverless-http');
  const app = express(); app.set('trust proxy', 1);
  let queries = 0;
  require('../src/routes/gamesGeneric').registerReferralEntry(app, async sql => {
    queries++;
    if (/FROM activities/.test(sql)) return { rows: [{ status: 'active', referral_bonus_per: 1 }] };
    if (/FROM users/.test(sql)) return { rows: [{}] };
    if (/INSERT/.test(sql)) return { rows: [{ id: 1 }] };
    throw Error('Unexpected fixture query');
  },
    { gameType: 'wheel', defaultLiffId: 'mock-liff' });
  const handler = serverless(app);
  function event(ip) { return { httpMethod: 'GET', path: '/invite/wheel/a',
    queryStringParameters: { ref: 'invalid' }, headers: ip ? { 'x-nf-client-connection-ip': ip } : {},
    requestContext: { identity: {} }, body: null, isBase64Encoded: false }; }
  assert.equal((await handler(event())).statusCode, 400);
  assert.equal((await handler(event('not-an-ip'))).statusCode, 400);
  for (let i = 0; i < 60; i++) assert.equal((await handler(event('198.51.100.1'))).statusCode, 400);
  assert.equal((await handler(event('198.51.100.1'))).statusCode, 429);
  assert.equal((await handler(event('198.51.100.2'))).statusCode, 400);
  assert.equal(queries, 0);
  const valid = event('198.51.100.3'); valid.queryStringParameters.ref = INVITER;
  const redirect = await handler(valid);
  assert.equal(redirect.statusCode, 302);
  assert.match(redirect.headers.location, /journey=1\.[A-Za-z0-9_-]{43}/);
  assert.equal(queries, 3);
});

test('即使關閉 token 強制模式，旅程仍只能綁給 LINE 已驗證的 sub', async () => {
  const old=process.env.LIFF_TOKEN_ENFORCE;
  process.env.LIFF_TOKEN_ENFORCE='0';
  let writes=0;
  try {
    const handler=routes(async (sql) => { if (/UPDATE/.test(sql)) writes++;return {rows:[]}; })['POST /api/games/wheel/:slug/referral'].at(-1);
    const response=res();
    await handler({params:{slug:'share-miles'},body:{line_user_id:INVITEE,inviter_line_user_id:INVITER,journey:PROOF}},response);
    assert.equal(response.code,401);assert.equal(writes,0);
  } finally { if(old===undefined)delete process.env.LIFF_TOKEN_ENFORCE;else process.env.LIFF_TOKEN_ENFORCE=old; }
});

test('URL 清除後仍會攜帶旅程重送，不會把上一位邀請人的憑證帶給別人', async () => {
  const dom = new JSDOM('<body/>',{url:'https://crm.test/games/wheel/share-miles?ref='+INVITER+'&journey='+PROOF,runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, sent=[];
  w.eval(source);w.liff={getAccessToken:()=> 'mock-access'};
  w.fetch=async (_u,o)=> { sent.push(JSON.parse(o.body)); return {ok:false,json:async()=>({error:'network_error'})}; };
  const options={slug:'share-miles',gameType:'wheel',userId:INVITEE,getIdToken:()=> 'mock-id'};
  await w.ORMGM.referral(options);
  assert.equal(w.location.search,'');assert.equal(sent[0].journey,PROOF);
  await w.ORMGM.referral(options);assert.equal(sent[1].journey,PROOF);
  w.history.replaceState({},'', '?ref=U'+'c'.repeat(32));
  await w.ORMGM.referral(options);assert.equal(sent[2].journey,'');
  dom.window.close();
});

test('手機跳 LINE 與電腦 QR 都保留憑證；一般 QR 不可夾帶任意網址', () => {
  assert.equal(new URL(buildOpenInLineUrl('2000000000-test','wheel','share-miles',INVITER,PROOF)).searchParams.get('journey'),PROOF);
  assert.ok(!buildOpenInLineUrl('L','wheel','a',INVITER,'https://evil.test').includes('evil'));
  const dom=new JSDOM('<body/>',{url:'https://crm.test/games/wheel/share-miles?ref='+INVITER+'&journey='+PROOF,runScripts:'outside-only'});
  dom.window.eval(source);
  const result=dom.window.ORMGM.openInLine({liffId:'L',gameType:'wheel',slug:'share-miles'});
  assert.equal(new URL(result.url).searchParams.get('journey'),PROOF);
  assert.ok(dom.window.document.getElementById('open-in-line-qr').src.includes('journey='+PROOF));
  dom.window.close();
});

test('新版旅程重試不改寫歷史快照、不插入第二筆、不推播', async () => {
  let inserts=0;
  const result=await registerReferral({query:async sql=> {
    if (/FROM activities/.test(sql))return {rows:[{id:6,status:'active',referral_bonus_per:1}]};
    if (/SELECT 1 FROM users/.test(sql))return {rows:[{}]};
    if (/SELECT inviter_line_user_id, invitee_was_existing/.test(sql))return {rows:[{inviter_line_user_id:INVITER,invitee_was_existing:true}]};
    inserts++;throw Error('No writes allowed');
  },activitySlug:'share-miles',gameType:'wheel',inviterId:INVITER,inviteeId:INVITEE,journeyStartedAt:START});
  assert.equal(result.counted,false);assert.equal(result.invitee_was_existing,true);assert.equal(inserts,0);
});

test('follow webhook 接續已綁旅程，傳入內部 follow 證據', async () => {
  let evidenceChecked=false,referralWrites=0;
  const result=await completePendingActivityReferralsForFollow({query:async (sql,params)=> {
    if (/SELECT DISTINCT ON/.test(sql))return {rows:[{activity_slug:'share-miles',game_type:'mgm',inviter_line_user_id:INVITER,journey_started_at:START}]};
    if (/FROM activities/.test(sql))return {rows:[{id:6,status:'active',referral_bonus_per:1}]};
    if (/SELECT 1 FROM users/.test(sql))return {rows:[{}]};
    if (/WITH member AS/.test(sql)){evidenceChecked=true;assert.equal(params[2],'2026-10-01T08:00:02Z');return {rows:[{was_existing:false}]};}
    if (/INSERT INTO activity_referrals/.test(sql)){referralWrites++;assert.equal(params[3],false);return {rows:[{id:1}]};}
    return {rows:[]};
  },inviteeId:INVITEE,followEvidence:{at:'2026-10-01T08:00:02Z',isUnblocked:false}});
  assert.equal(evidenceChecked,true);assert.equal(referralWrites,1);assert.equal(result[0].result.counted,true);
});

test('有旅程但缺少好友資格證據：不寫入 NULL、不占唯一鍵、不通知邀請人', async () => {
  let writes=0;
  const result=await registerReferral({query:async sql=> {
    if (/FROM activities/.test(sql))return {rows:[{id:6,status:'active',referral_bonus_per:1}]};
    if (/SELECT 1 FROM users/.test(sql))return {rows:[{}]};
    if (/SELECT inviter_line_user_id|admin_test_recipients/.test(sql))return {rows:[]};
    if (/WITH member AS/.test(sql))return {rows:[{was_existing:null}]};
    writes++;throw Error('No write allowed');
  },activitySlug:'share-miles',gameType:'wheel',inviterId:INVITER,inviteeId:INVITEE,journeyStartedAt:START});
  assert.equal(result.error.code,'invitee_status_unavailable');assert.equal(writes,0);
});

test('超出 bigint 的假旅程 ID 不進 SQL，避免錯誤及繞過綁定', async () => {
  let queries=0;
  assert.equal(await claimReferralJourney({query:async()=>{queries++;return {rows:[]};},proof:'9999999999999999999.'+'x'.repeat(43)}),null);
  assert.equal(queries,0);
});

test('瀏覽器早於 webhook log 時會有限重試；無 localStorage 也最多四次', async () => {
  for(const succeeds of [true,false]){
    const dom=new JSDOM('<body/>',{url:'https://crm.test/games/wheel/share-miles?ref='+INVITER+'&journey='+PROOF,runScripts:'outside-only',pretendToBeVisual:true});
    const w=dom.window;w.eval(source);
    Object.defineProperty(w,'localStorage',{get(){throw Error('storage unavailable');}});
    const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>timeout(fn,Math.min(ms,1));
    let calls=0;
    w.fetch=async()=>{calls++;const ok=succeeds&&calls===2;return {ok,json:async()=>ok?{ok:true,counted:true,invitee_was_existing:false}:{error:'invitee_status_unavailable'}};};
    const result=await w.ORMGM.referral({slug:'share-miles',gameType:'wheel',userId:INVITEE});
    assert.equal(calls,succeeds?2:4);assert.equal(result.state,succeeds?'done':'pending');
    dom.window.close();
  }
});
