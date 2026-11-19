'use strict';
// 自動化／關鍵字／歡迎訊息直達 LIFF：活動頁按「完成」關閉後不留下 /t/e 中轉頁的空白視窗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildDirectLiffExecutionUrl, parseExecutionReference } = require('../src/core/broadcastDirectLiff');
const { prepareExecutionTracking } = require('../src/core/messageTrackingTargets');
const { createExecutionLiffHitHandler } = require('../src/routes/broadcastDirectLiff');
const { integrate, upgrade } = require('../scripts/qa/package-dineback-direct-liff.cjs');

const ID = '1234567890-Abcd';
const UID = 'U' + '1'.repeat(32);
const CODE = 'STAGINGcode'.padEnd(32, 'x');
const LIFF = 'https://liff.line.me/' + ID + '?g=A&src=flow_1118';
const ENV = { BROADCAST_DIRECT_LIFF_ENABLED: '1', BROADCAST_DIRECT_LIFF_APPS: JSON.stringify({ [ID]: 'https://activity.example/event/index.html' }), GAMES_LIFF_ID: '2000000000-Games' };

test('直達網址：已設定的活動 LIFF 加上 or_ex，保留 g／src 與 #；未啟用或其他網址不變', () => {
  assert.equal(buildDirectLiffExecutionUrl(LIFF + '#top', { code: CODE, index: 0 }, ENV), LIFF + '&or_ex=' + CODE + '.0#top');
  assert.equal(buildDirectLiffExecutionUrl('https://liff.line.me/' + ID, { code: CODE, index: 3 }, ENV), 'https://liff.line.me/' + ID + '?or_ex=' + CODE + '.3');
  assert.equal(buildDirectLiffExecutionUrl(LIFF, { code: CODE, index: 0 }, { ...ENV, BROADCAST_DIRECT_LIFF_ENABLED: '0' }), null);
  assert.equal(buildDirectLiffExecutionUrl('https://liff.line.me/9999-Other', { code: CODE, index: 0 }, ENV), null);
  assert.equal(buildDirectLiffExecutionUrl('https://example.com/', { code: CODE, index: 0 }, ENV), null);
  assert.equal(buildDirectLiffExecutionUrl(LIFF + '&or_ex=' + CODE + '.0', { code: CODE, index: 1 }, ENV), null, '不重複加');
  assert.equal(buildDirectLiffExecutionUrl(LIFF, { code: 'short', index: 0 }, ENV), null);
  assert.deepEqual(parseExecutionReference(CODE + '.12'), { code: CODE, index: 12 });
  for (const bad of [CODE + '.01', CODE + '.a', CODE, CODE + '.1&x=1', '1.2.0.-']) assert.equal(parseExecutionReference(bad), null, bad);
});

function messages() {
  return [{ type: 'flex', altText: 'STAGING', contents: { type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [
    { type: 'button', action: { type: 'uri', label: '去登錄', uri: LIFF } },
    { type: 'button', action: { type: 'uri', label: '活動辦法', uri: 'https://example.com/rules' } }
  ] } } }];
}

test('流程訊息：活動 LIFF 按鈕直接開 LIFF，其他按鈕照舊走中轉頁；目標清單記下 direct', async () => {
  const saved = [];
  const out = await prepareExecutionTracking(async (_sql, p) => { saved.push(JSON.parse(p[1])); return { rows: [] }; }, { id: 5, code: CODE }, messages(), 'https://crm.example', ENV);
  const [a, b] = out[0].contents.footer.contents.map(x => x.action.uri);
  assert.equal(a, LIFF + '&or_ex=' + CODE + '.0');
  assert.equal(b, 'https://liff.line.me/2000000000-Games/t/e/' + CODE + '/1');
  assert.equal(saved[0][0].uri, LIFF, '目標清單保存原網址，回報時用來比對');
  assert.equal(saved[0][0].direct, true);
  assert.equal(saved[0][1].direct, undefined);
});

test('流程訊息：開關關閉時完全照舊（全部走中轉頁）', async () => {
  const out = await prepareExecutionTracking(async () => ({ rows: [] }), { id: 5, code: CODE }, messages(), 'https://crm.example', { ...ENV, BROADCAST_DIRECT_LIFF_ENABLED: '0' });
  assert.equal(out[0].contents.footer.contents[0].action.uri, 'https://liff.line.me/2000000000-Games/t/e/' + CODE + '/0');
});

test('流程訊息：沒有中轉 LIFF 設定時，活動 LIFF 仍直達、其他網址不動', async () => {
  const env = { ...ENV }; delete env.GAMES_LIFF_ID;
  const out = await prepareExecutionTracking(async () => ({ rows: [] }), { id: 5, code: CODE }, messages(), 'https://crm.example', env);
  const [a, b] = out[0].contents.footer.contents.map(x => x.action.uri);
  assert.equal(a, LIFF + '&or_ex=' + CODE + '.0');
  assert.equal(b, 'https://example.com/rules');
});

function setup({ execution = {}, verify, fail = false, inserted = true } = {}) {
  const calls = [], auth = [];
  const query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT * FROM crm_message_executions')) {
      return { rows: [{ id: 41, code: CODE, status: 'accepted', test_only: false, recipient_key: UID, source_type: 'automation',
        source_event_id: '777:88:n2', targets: [{ index: 0, uri: LIFF, direct: true }, { index: 1, uri: 'https://example.com/rules' }], ...execution }] };
    }
    if (fail) throw Error('private database detail');
    return { rows: [{ recorded: inserted }] };
  };
  const handler = createExecutionLiffHitHandler({ env: ENV, query, verifyToken: async (...a) => { auth.push(a); return verify || { ok: true, sub: UID, aud: '1234567890' }; } });
  const req = { body: { reference: CODE + '.0', liff_id: ID, id_token: 'test-token', page_path: '/event/index.html' }, get: k => k === 'origin' ? 'https://activity.example' : '', query: {} };
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
  return { calls, auth, req, res, handler };
}
const writes = x => x.calls.filter(c => c.sql.includes('INSERT INTO'));

test('回報：原收件人記一次點擊，同時寫入流程「點了連結」紀錄；event_key 固定（重新整理不多算）', async () => {
  const x = setup(); await x.handler(x.req, x.res);
  assert.equal(x.res.code, 200); assert.deepEqual(x.res.body, { ok: true, recorded: true });
  assert.equal(x.auth[0][1], '1234567890');
  assert.equal(x.res.headers['Access-Control-Allow-Origin'], 'https://activity.example');
  const w = writes(x)[0];
  assert.match(w.sql, /INSERT INTO crm_message_clicks/); assert.match(w.sql, /INSERT INTO admin_flow_clicks/);
  assert.deepEqual(w.args.slice(0, 3), [41, 0, UID]);
  assert.deepEqual(w.args.slice(4), [777, 88, LIFF]);
  const y = setup({ inserted: false }); await y.handler(y.req, y.res);
  assert.equal(writes(y)[0].args[3], w.args[3], '同一人同一按鈕 event_key 相同 → ON CONFLICT 不重複');
  assert.deepEqual(y.res.body, { ok: true, recorded: false });
});

test('回報：關鍵字／歡迎訊息只寫 crm_message_clicks', async () => {
  const x = setup({ execution: { source_type: 'keyword', source_event_id: 'evt-1' } }); await x.handler(x.req, x.res);
  assert.equal(x.res.code, 200);
  assert.doesNotMatch(writes(x)[0].sql, /admin_flow_clicks/);
});

test('回報：網域、路徑、參考碼、預覽、其他 LIFF 一律拒絕，不驗證身分、不查資料庫', async () => {
  for (const alter of [x => { x.req.get = () => 'https://evil.example'; }, x => { x.req.body.page_path = '/other.html'; },
    x => { x.req.body.reference = '91.92.0.-'; }, x => { x.req.body.reference = CODE + '.0&x'; }, x => { x.req.body.preview = true; },
    x => { x.req.query.preview = '1'; }, x => { x.req.body.liff_id = '9999-Other'; }]) {
    const x = setup(); alter(x); await x.handler(x.req, x.res);
    assert.notEqual(x.res.code, 200); assert.equal(x.calls.length, 0); assert.equal(x.auth.length, 0);
  }
});

test('回報：身分驗證失敗、頻道不符、缺 sub 都回 401 且不查資料庫', async () => {
  for (const verify of [{ ok: false }, { ok: true, sub: UID, aud: '9999' }, { ok: true, aud: '1234567890' }]) {
    const x = setup({ verify }); await x.handler(x.req, x.res); assert.equal(x.res.code, 401); assert.equal(x.calls.length, 0);
  }
});

test('回報：轉傳給別人、未送達、測試訊息、目的地不是這個 LIFF、找不到訊息都不記錄', async () => {
  for (const execution of [{ recipient_key: 'U' + '2'.repeat(32) }, { status: 'pending' }, { status: 'uncertain' }, { test_only: true },
    { targets: [{ index: 0, uri: 'https://example.com/rules' }] }, { targets: [] }]) {
    const x = setup({ execution }); await x.handler(x.req, x.res);
    assert.equal(x.res.code, 403, JSON.stringify(execution)); assert.equal(writes(x).length, 0);
  }
  const x = setup(); x.req.body.reference = CODE + '.1'; await x.handler(x.req, x.res);
  assert.equal(x.res.code, 403, '序號 1 是一般網址，不能用來記錄'); assert.equal(writes(x).length, 0);
});

test('回報：資料庫錯誤回 503，不外洩細節', async () => {
  const x = setup({ fail: true }); await x.handler(x.req, x.res);
  assert.equal(x.res.code, 503); assert.deepEqual(x.res.body, { ok: false, error: 'tracking_unavailable' });
});

const HELPER = fs.readFileSync(path.join(__dirname, '../public/broadcast-direct-liff.js'), 'utf8');
async function helperRun(search) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://activity.example/event/index.html' + search, runScripts: 'outside-only' });
  const posts = [];
  dom.window.fetch = async (u, o) => { posts.push({ u, body: JSON.parse(o.body) }); return { ok: true }; };
  dom.window.eval(HELPER);
  const ok = await dom.window.OpenRiceBroadcastTracking.record({ liff: { id: ID, getIDToken: () => 'tok' }, liffId: ID, crmOrigin: 'https://openrice-line-crm.netlify.app', preview: false });
  dom.window.close();
  return { ok, posts };
}

test('活動頁追蹤程式：or_ex 送到 execution 回報、or_bc 照舊；兩個同時出現或格式錯誤都不送', async () => {
  const ex = await helperRun('?g=A&or_ex=' + CODE + '.0');
  assert.equal(ex.posts.length, 1);
  assert.equal(ex.posts[0].u, 'https://openrice-line-crm.netlify.app/tracking/execution/liff-hit');
  assert.equal(ex.posts[0].body.reference, CODE + '.0');
  assert.equal(ex.posts[0].body.page_path, '/event/index.html');
  const bc = await helperRun('?or_bc=12.345.0.a');
  assert.equal(bc.posts[0].u, 'https://openrice-line-crm.netlify.app/tracking/broadcast/liff-hit');
  for (const s of ['?or_bc=12.345.0.a&or_ex=' + CODE + '.0', '?or_ex=bad.0', '?or_ex=' + CODE + '.0&or_ex=' + CODE + '.1', '?or_ex=' + CODE + '.0&demo=1', '']) {
    assert.equal((await helperRun(s)).posts.length, 0, s);
  }
});

test('活動頁升級：只替換追蹤程式本體，呼叫位置與其他內容逐字不變；未整合或已最新會拒絕', () => {
  const original = 'x\n/* ---------- 初始化 ---------- */\ny\n    window.OpenRiceAnalytics.start(DEMO);\n    show("view-form");\nz\n';
  const oldHelper = '/* OR_DIRECT_LIFF_BEGIN */\n(function(){ window.OpenRiceBroadcastTracking = { record: async function(){ return false; } }; })();\n/* OR_DIRECT_LIFF_END */\n';
  const integrated = integrate(original, 'https://openrice-line-crm.netlify.app');
  const legacy = integrated.replace(/\/\* OR_DIRECT_LIFF_BEGIN \*\/\n[\s\S]*?\/\* OR_DIRECT_LIFF_END \*\/\n/, () => oldHelper);
  const up = upgrade(legacy);
  assert.equal(up, integrated, '升級後與用目前版本整合的結果完全相同');
  assert.match(up, /or_ex/);
  assert.throws(() => upgrade(original), /Not a previously integrated/);
  assert.throws(() => upgrade(integrated), /Already up to date/);
});
