'use strict';
// 1) 成效列出每一顆按鍵（沒人點也顯示 0）  2) 發送文字重複的按鍵：提醒並標示合併
// 3) 比對按鍵文字時優先用現役／最新的選單  4) 「不設定點擊動作」：不建立點擊區
// 5) 從專屬來源加入、且來源流程勾「取代通用歡迎訊息」→ 不再收到通用歡迎
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildLineMenuObject, sanitizeMenuConfig } = require('../src/core/lineRichMenu');
const { listMenuButtons, registerAdminRichMenuRoutes } = require('../src/routes/adminRichMenu');
const { createFlowEngine } = require('../src/core/flowEngine');
const { createLineWebhookHandler } = require('../src/routes/lineWebhook');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const btn = (label, action) => ({ label, sublabel: '', icon: null, image: null, bg: null, action });
const TWO_TABS = {
  name: 'STAGING 選單', size: 'large',
  tabs: [
    { label: 'A', layout: 'x', cells: [{ x: 0, y: 200, w: 1250, h: 700 }, { x: 1250, y: 200, w: 1250, h: 700 }],
      buttons: [btn('開飯試手氣', { type: 'uri', uri: 'https://example.com/a' }), btn('未領取獎勵A', { type: 'message', text: '未領取獎勵' })] },
    { label: 'B', layout: 'x', cells: [{ x: 0, y: 200, w: 1250, h: 700 }, { x: 1250, y: 200, w: 1250, h: 700 }],
      buttons: [btn('更改訂位', { type: 'message', text: '更改訂位' }), btn('未領取獎勵B', { type: 'message', text: '未領取獎勵' })] }
  ]
};

// ---------------------------------------------------------------- 4) 不設定點擊動作
test('不設定點擊動作：該格不建立點擊區、可以是空白；整頁都不可點才擋下', () => {
  const cfg = { name: 'x', size: 'large', cells: [{ x: 0, y: 0, w: 1250, h: 1686 }, { x: 1250, y: 0, w: 1250, h: 1686 }],
    buttons: [btn('訂位', { type: 'uri', uri: 'https://example.com/book' }), btn('', { type: 'none' })] };
  const menu = buildLineMenuObject(cfg, {});
  assert.equal(menu.areas.length, 1, '只有 A 是有效範圍');
  assert.deepEqual(menu.areas[0].bounds, { x: 0, y: 0, width: 1250, height: 1686 });
  const none = { name: 'x', size: 'large', cells: cfg.cells, buttons: [btn('', { type: 'none' }), btn('', { type: 'none' })] };
  assert.throws(() => buildLineMenuObject(none, {}), /至少要有一格設定點擊動作/);
  assert.deepEqual(sanitizeMenuConfig(cfg).buttons[1].action, { type: 'none' }, '存檔時保留「不設定點擊動作」');
});

test('編輯器有「不設定點擊動作」選項，發布前檢查允許空白但至少一格可點', () => {
  const v = fs.readFileSync(path.join(REPO, 'views/admin_richmenu.ejs'), 'utf8');
  assert.match(v, /data-mode="none" class="rm-actbtn">不設定點擊動作</);
  assert.match(v, /按了不會有任何反應/);
  assert.match(v, /if\(a\.type==='none'\)continue;/);
  assert.match(v, /至少要有一格設定點擊動作/);
  assert.match(v, /（不可點）/, '編輯畫面標示不可點的格子（不會印在正式圖上）');
});

// ---------------------------------------------------------------- 1) 2) 成效列出所有按鍵、重複文字
test('列出選單每一顆按鍵（不含不可點的格子），並找出發送文字相同的按鍵與點擊會記在哪一顆', () => {
  const withNone = JSON.parse(JSON.stringify(TWO_TABS));
  withNone.tabs[0].cells.push({ x: 0, y: 900, w: 2500, h: 700 });
  withNone.tabs[0].buttons.push(btn('', { type: 'none' }));
  const { buttons, duplicates } = listMenuButtons(withNone);
  assert.deepEqual(buttons.map(b => b.name), ['分頁A・開飯試手氣', '分頁A・未領取獎勵A', '分頁B・更改訂位', '分頁B・未領取獎勵B']);
  assert.deepEqual(duplicates, [{ text: '未領取獎勵', buttons: ['分頁A・未領取獎勵A', '分頁B・未領取獎勵B'],
    credited_to: '分頁B・未領取獎勵B', credited_tab: 1, credited_cell: 1 }]);
});

test('成效 API 一併回傳按鍵清單與重複文字', async () => {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  registerAdminRichMenuRoutes(app, {
    query: async (sql) => /FROM rich_menu_taps/.test(sql)
      ? { rows: [{ tab: 1, cell: 1, kind: 'message', label: '未領取獎勵B', taps: 104, taps_7d: 55, people: 72, identified_taps: 104 }] }
      : /FROM rich_menus WHERE id/.test(sql) ? { rows: [{ config: TWO_TABS, published_config: TWO_TABS }] } : { rows: [] },
    authCore: { requireAdmin: (_q, _s, n) => n() }
  });
  const res = { json(b) { this.body = b; return this; }, status() { return this; } };
  await routes['GET /admin/richmenu/api/stats'].at(-1)({ query: { id: '3' } }, res);
  assert.equal(res.body.buttons.length, 4);
  assert.equal(res.body.duplicates[0].credited_to, '分頁B・未領取獎勵B');
});

test('成效視窗：沒人點的按鍵顯示 0；文字重複的按鍵顯示「合併記在」並提醒原因', async () => {
  const ejs = require('ejs');
  const { JSDOM } = require('jsdom');
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_richmenu.ejs'), { user: 'STAGING', isAdmin: true, title: '圖文選單', bodyClass: 'admin-shell' }, { views: [path.join(REPO, 'views')] });
  const { buttons, duplicates } = listMenuButtons(TWO_TABS);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://crm.example/admin/richmenu', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (u) => {
        u = String(u);
        if (u.indexOf('/api/stats') >= 0) return { json: async () => ({ ok: true, buttons, duplicates, stats: [
          { tab: 0, cell: 0, kind: 'link', label: '開飯試手氣', taps: 58, taps_7d: 33, people: 51, identified_taps: 58 },
          { tab: 1, cell: 1, kind: 'message', label: '未領取獎勵B', taps: 104, taps_7d: 55, people: 72, identified_taps: 104 },
          { tab: 1, cell: null, kind: 'tab', label: null, taps: 383, taps_7d: 229, people: 316, identified_taps: 383 }] }) };
        if (u.indexOf('/api/data') >= 0) return { json: async () => ({ ok: true, liff_id: '', activities: [], lists: [],
          menus: [{ id: 3, name: 'STAGING 選單', status: 'published', is_default: true, line_rich_menu_id: 'rm-1', config: TWO_TABS, published_config: TWO_TABS }] }) };
        return { json: async () => ({ ok: true }) };
      };
    } });
  await wait(150);
  const doc = dom.window.document;
  const sb = doc.querySelector('.rm-stats');
  assert.ok(sb, '有成效按鈕');
  sb.click();
  await wait(60);
  const rows = [...doc.querySelectorAll('#rm-stats-body tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
  const find = (n) => rows.find(r => r[0] === n);
  assert.deepEqual(find('分頁A・開飯試手氣').slice(2), ['58', '33', '51']);
  assert.deepEqual(find('分頁A・未領取獎勵A').slice(2), ['合併記在「分頁B・未領取獎勵B」']);
  assert.deepEqual(find('分頁B・更改訂位').slice(2), ['0', '0', '0'], '沒人點也列出來');
  assert.deepEqual(find('分頁B・未領取獎勵B').slice(2), ['104', '55', '72']);
  assert.ok(find('切到分頁B'));
  assert.match(doc.getElementById('rm-stats-body').textContent, /送出相同的文字「未領取獎勵」，系統分不出是按了哪一顆/);
  dom.window.close();
});

// ---------------------------------------------------------------- 3) 按鍵文字比對優先用現役／最新選單
const SECRET = 'STAGING_SECRET';
async function sendText(pool, text) {
  globalThis.__rmBtnCache = null;
  const handler = createLineWebhookHandler({ pool, channelSecret: SECRET, linePush: { replyLineMessages: async () => true, replyLineMessagesDetailed: async () => ({ status: 'accepted' }) } });
  const body = Buffer.from(JSON.stringify({ events: [{ type: 'message', webhookEventId: crypto.randomUUID(), replyToken: 'R', source: { type: 'user', userId: 'U' + 'a'.repeat(32) }, message: { type: 'text', text } }] }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  await handler({ body, get: () => sig }, { status() { return this; }, send() { return this; }, json() { return this; } });
}
test('發送文字按鍵比對：只取現役預設＋最新發布的選單；同字時記在現役選單', async () => {
  const taps = [];
  let menuSql = '';
  const mk = (id, text) => ({ id, published_config: { cells: [{ x: 0, y: 0, w: 10, h: 10 }], buttons: [btn('獎勵', { type: 'message', text })] } });
  const pool = { query: async (sql, p) => {
    const s = String(sql);
    if (/FROM rich_menus/.test(s) && /status='published'/.test(s)) {
      menuSql = s;
      // 資料庫依「現役預設優先、再依發布時間新到舊」排好回傳：第一筆是現役預設
      return { rows: [mk(99, '未領取獎勵'), mk(50, '未領取獎勵'), mk(10, '更改訂位')] };
    }
    if (/INSERT INTO rich_menu_taps/.test(s)) { taps.push(p); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  await sendText(pool, '未領取獎勵');
  assert.match(menuSql, /ORDER BY is_default DESC, published_at DESC NULLS LAST LIMIT 30/);
  assert.equal(taps.length, 1);
  assert.equal(taps[0][0], 99, '同字時記在現役預設選單');
});

// ---------------------------------------------------------------- 5) 專屬來源取代通用歡迎
function followHarness({ source = null, flows = [], sourceFails = false, noEntry = false, entryType = 'send', enrollmentFails = false, capReached = false, existing = false, active = false, sameEvent = false, invalidTemplate = false } = {}) {
  const seen = { welcomeLoad: 0, enrolledFlows: [] };
  const query = async (sql, p = []) => {
    const s = String(sql);
    if (/FROM admin_flows WHERE status = 'active' AND trigger_type = \$1/.test(s)) return { rows: flows, rowCount: flows.length };
    if (/FROM line_follow_sources/.test(s)) { if (sourceFails) throw new Error('db'); return source ? { rows: [{ source_key: source }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
    if (/FROM crm_welcome_settings/.test(s)) { seen.welcomeLoad++; return { rows: [{ enabled: false }], rowCount: 1 }; }
    if (/FROM admin_message_templates/.test(s)) return { rows: invalidTemplate ? [] : [{ message_config: {mode:'sequence',items:[{type:'text',text:'QA'}]} }], rowCount:invalidTemplate?0:1 };
    if (/FROM admin_flow_nodes WHERE flow_id = \$1/.test(s)) return { rows: noEntry ? [] : [{node_key:'entry',type:entryType,config:{message_id:1}}], rowCount:noEntry?0:1 };
    if (/COUNT\(\*\).*AS n/.test(s)) return {rows:[{n:capReached?1:0}],rowCount:1};
    if (/SELECT 1 FROM admin_flow_enrollments/.test(s)) { const yes=s.includes("status='active'")?(active||sameEvent):existing;return {rows:yes?[{}]:[],rowCount:yes?1:0}; }
    if (/INSERT INTO admin_flow_enrollments/.test(s)) { if(enrollmentFails && p[0]===7)throw Error('QA DB enrollment failed');seen.enrolledFlows.push(p[0]);return {rows:[{id:1}],rowCount:1}; }
    return { rows: [], rowCount: 0 };
  };
 const engine = createFlowEngine({ query, pool: { connect: async () => ({ query, release() {} }) }, linePush: {}, buildLineMessages: require('../src/core/broadcastTemplates').buildLineMessages });
  return { engine, seen };
}
const fbFlow = (extra) => ({ id: 7, name: 'FB 專屬歡迎', status: 'active', trigger_type: 'follow', trigger_config: Object.assign({ source_key: 'fb_ad', replace_welcome:true }, extra || {}) });
const generalFlow = { id: 8, name: '自動名單：新好友', status: 'active', trigger_type: 'follow', trigger_config: {} };

test('從 fb_ad 進來且 FB 流程要取代通用歡迎：不發通用歡迎，FB 流程與通用流程照跑', async () => {
  const { engine, seen } = followHarness({ source: 'fb_ad', flows: [fbFlow(), generalFlow] });
  await engine.triggerFollow('U' + 'b'.repeat(32), 1, { webhookEventId: 'E1' });
  assert.equal(seen.welcomeLoad, 0, '不發通用歡迎');
  assert.deepEqual(seen.enrolledFlows, [7, 8]);
});

test('沒有來源、來源不同、或流程取消勾選：照常發通用歡迎；查來源失敗也退回照發', async () => {
  for (const c of [{ source: null }, { source: 'store_qr' }, { source: 'fb_ad', replace: false }, { source: 'fb_ad', sourceFails: true }]) {
    const { engine, seen } = followHarness({ source: c.source, sourceFails: c.sourceFails, flows: [fbFlow(c.replace === false ? { replace_welcome: false } : {}), generalFlow] });
    await engine.triggerFollow('U' + 'c'.repeat(32), 1, { webhookEventId: 'E2' });
    assert.equal(seen.welcomeLoad, 1, JSON.stringify(c) + ' 要照發通用歡迎');
  }
});

test('流程設定：取代通用歡迎須明確勾選；沒來源不帶設定；介面有說明', () => {
  const v = fs.readFileSync(path.join(REPO, 'views/admin_flows.ejs'), 'utf8');
  assert.match(v, /id="tc-replace-welcome"/);
  assert.match(v, /取代通用歡迎訊息/);
  assert.match(v, /c\.replace_welcome===true\?' checked':''/);
  const r = fs.readFileSync(path.join(REPO, 'src/routes/adminFlows.js'), 'utf8');
  assert.match(r, /tCfg\.replace_welcome = tCfg\.replace_welcome === true;/);
  assert.match(r, /delete tCfg\.replace_welcome;/);
  const w = fs.readFileSync(path.join(REPO, 'public/admin-welcome-messages.js'), 'utf8');
  assert.match(w, /不會收到這則通用歡迎/);
  assert.match(w, /LINE 官方帳號後台的「加入好友的歡迎訊息」/);
});

test('替代未成立時保留通用歡迎：無入口、加入失敗、上限、非訊息入口、舊流程未勾選及已結束舊報名',async()=>{
 for(const options of [{noEntry:true},{enrollmentFails:true},{capReached:true},{entryType:'add_tag'},{entryType:'wait'},{entryType:'branch'},{existing:true},{invalidTemplate:true}]){
  const flow=fbFlow(options.capReached?{user_limit:{max:1,window:'lifetime'}}:{});
  const c=followHarness({source:'fb_ad',flows:[flow],...options});
  await c.engine.triggerFollow('U'+'d'.repeat(32),1,{webhookEventId:'QA'});
  assert.equal(c.seen.welcomeLoad,1,JSON.stringify(options));
 }
 const legacy=fbFlow();delete legacy.trigger_config.replace_welcome;
 const c=followHarness({source:'fb_ad',flows:[legacy]});await c.engine.triggerFollow('U'+'e'.repeat(32),1,{});
 assert.equal(c.seen.welcomeLoad,1);
});

test('專屬流程加入失敗不阻斷其他流程；已在進行中的專屬流程不另發通用歡迎',async()=>{
 const failed=followHarness({source:'fb_ad',flows:[fbFlow(),generalFlow],enrollmentFails:true});
 await failed.engine.triggerFollow('U'+'f'.repeat(32),1,{webhookEventId:'QA'});
 assert.equal(failed.seen.welcomeLoad,1);assert.deepEqual(failed.seen.enrolledFlows,[8]);
 const c=followHarness({source:'fb_ad',flows:[fbFlow(),generalFlow],existing:true,active:true});
 await c.engine.triggerFollow('U'+'f'.repeat(32),1,{webhookEventId:'QA'});
 assert.equal(c.seen.welcomeLoad,0);
 const replay=followHarness({source:'fb_ad',flows:[fbFlow()],existing:true,sameEvent:true});
 await replay.engine.triggerFollow('U'+'f'.repeat(32),1,{webhookEventId:'QA'});assert.equal(replay.seen.welcomeLoad,0);
});
