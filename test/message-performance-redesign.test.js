'use strict';
// 訊息成效改版：一則訊息一列、看得出是哪一篇、指標定義在頁面上、時間可篩選。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(REPO, 'public/admin-message-performance.js'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));
const twToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (ymd, d) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

const ROWS = [
  { key: 'broadcast:90', type: 'broadcast', typeLabel: '群發', sourceId: 90, title: '中秋抽機票｜轉輪盤抽 26,000 哩', notification: '中秋限定', thumb: 'https://img.example/a.jpg',
    context: '批次 #90 · A/B 測試', link: '/admin/broadcast/90', basis: 'recipient_link', firstAt: '2026-10-01T04:00:00Z', lastAt: '2026-10-01T04:00:00Z',
    sends: 4, people: 3, clickers: 2, clicks: 3, tracked: true, rate: 66.7, failures: { rejected: 1, uncertain: 0, skipped: 0, pending: 0 },
    variants: [
      { variant: 'a', title: 'A 版', notification: '封面 A', thumb: 'https://img.example/a.jpg', people: 2, clickers: 1, clicks: 2, tracked: true, rate: 50 },
      { variant: 'b', title: 'B 版', notification: '封面 B', thumb: 'https://img.example/b.jpg', people: 1, clickers: 1, clicks: 1, tracked: true, rate: 100 }] },
  { key: 'automation:5:202', type: 'automation', typeLabel: '自動化', sourceId: 5, revision: '202', title: '感謝您的訂位', notification: '', thumb: '',
    context: '流程「訂位回訪」', link: '/admin/flows/5', basis: 'verified', firstAt: '2026-10-02T01:00:00Z', lastAt: '2026-10-05T01:00:00Z',
    sends: 2, people: 2, clickers: null, clicks: null, tracked: false, rate: null, failures: { rejected: 0, uncertain: 0, skipped: 0, pending: 0 }, variants: [] },
  { key: 'welcome:1:101', type: 'welcome', typeLabel: '歡迎訊息', sourceId: 1, revision: '101', title: '歡迎加入 OpenRice', notification: '歡迎加入 OpenRice｜通知', thumb: '',
    context: '加入好友時自動送出', link: '/admin/welcome-messages', basis: 'verified', firstAt: '2026-10-07T01:00:00Z', lastAt: '2026-10-07T03:00:00Z',
    sends: 1, people: 0, clickers: 0, clicks: 0, tracked: true, rate: null, failures: { rejected: 1, uncertain: 0, skipped: 0, pending: 0 }, variants: [] }
];

async function openPage(url, opts = {}) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_message_performance.ejs'), { user: 'STAGING', isAdmin: true, title: '訊息成效' }, { views: [path.join(REPO, 'views')] });
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: url || 'https://crm.example/admin/message-performance', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async (u) => {
    calls.push(String(u));
    if (/\/messages\/detail/.test(u)) return { json: async () => (opts.detail || { ok: true, groups: [{ variant: 'a', links: [{ label: '前往', uri: 'https://example.com/a', clicks: 2, people: 1 }] }, { variant: 'b', links: [] }] }) };
    return { json: async () => (typeof opts.list === 'function' ? opts.list() : opts.list || { ok: true, rows: ROWS, truncated: false }) };
  };
  w.eval(SCRIPT);
  await wait(40);
  return { dom, w, doc: w.document, calls };
}

test('預設近 30 天（台灣日期）、類型下拉有歡迎訊息、指標定義寫在頁面上', async () => {
  const { dom, doc, calls } = await openPage();
  const t = twToday();
  assert.equal(doc.getElementById('mp-from').value, shift(t, -29));
  assert.equal(doc.getElementById('mp-to').value, t);
  assert.equal(doc.querySelector('[data-mp-range="30d"]').classList.contains('on'), true);
  assert.match(calls[0], new RegExp('/admin/message-performance/messages\\?from=' + shift(t, -29) + '&to=' + t + '$'));
  assert.ok(doc.querySelector('select[name="source"] option[value="welcome"]'));
  const defs = doc.getElementById('mp-defs').textContent;
  ['收到人數', '點擊人數', '點擊率', '點擊什麼', '時間', '怎麼確認是誰點的'].forEach(k => assert.ok(defs.includes(k), '定義要有：' + k));
  assert.match(defs, /點擊人數 ÷ 收到人數/);
  assert.match(defs, /送出時間/);
  assert.match(defs, /傳送文字」的按鈕都不算點擊/);
  dom.window.close();
});

test('每一列看得出是哪一篇：類型、名稱、來源說明、縮圖；A/B 展開各版本；不適用與尚無資料分開', async () => {
  const { dom, doc } = await openPage();
  const main = [...doc.querySelectorAll('#mp-tbody tr.mp-row')];
  assert.equal(main.length, 3);
  assert.match(main[0].textContent, /群發/);
  assert.match(main[0].textContent, /中秋抽機票｜轉輪盤抽 26,000 哩/);
  assert.match(main[0].textContent, /批次 #90 · A\/B 測試/);
  assert.match(main[0].querySelector('.mp-thumb').getAttribute('style'), /img\.example\/a\.jpg/);
  const subs = [...doc.querySelectorAll('#mp-tbody tr.mp-sub')].map(tr => [...tr.children].map(td => td.textContent.trim()));
  assert.deepEqual(subs.map(s => [s[0].slice(0, 3), s[2], s[3], s[4]]), [['A 版', '2', '1', '50%'], ['B 版', '1', '1', '100%']]);
  const cells = (tr) => [...tr.children].map(td => td.textContent.trim());
  assert.deepEqual(cells(main[1]).slice(2), ['2', '—', '不適用'], '沒有可追蹤連結：不適用');
  assert.deepEqual(cells(main[2]).slice(2), ['0', '0', '尚無資料'], '有連結但還沒人收到：尚無資料');
  const kpis = doc.getElementById('mp-kpis').textContent;
  assert.match(kpis, /3訊息數/);
  assert.match(kpis, /5收到人數（合計）/);
  assert.match(kpis, /66\.7%合計點擊率/, '合計點擊率只用有追蹤的訊息');
  dom.window.close();
});

test('搜尋：用名稱、通知文字、關鍵字或流程名稱篩選', async () => {
  const { dom, w, doc } = await openPage();
  const q = doc.getElementById('mp-q');
  q.value = '訂位回訪'; q.dispatchEvent(new w.Event('input'));
  assert.equal(doc.querySelectorAll('#mp-tbody tr.mp-row').length, 1);
  q.value = '不存在的訊息'; q.dispatchEvent(new w.Event('input'));
  assert.match(doc.getElementById('mp-tbody').textContent, /沒有符合搜尋的訊息/);
  dom.window.close();
});

test('時間篩選：快捷選項、自訂日期、起訖顛倒擋下；網址帶入來源與日期', async () => {
  const { dom, w, doc, calls } = await openPage();
  const t = twToday();
  doc.querySelector('[data-mp-range="7d"]').click();
  await wait(20);
  assert.match(calls.at(-1), new RegExp('from=' + shift(t, -6) + '&to=' + t));
  doc.querySelector('[data-mp-range="month"]').click();
  await wait(20);
  assert.match(calls.at(-1), new RegExp('from=' + t.slice(0, 8) + '01&to=' + t));
  doc.getElementById('mp-from').value = '2026-09-01';
  doc.getElementById('mp-from').dispatchEvent(new w.Event('change'));
  doc.getElementById('mp-to').value = '2026-09-15';
  doc.getElementById('mp-filters').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(20);
  assert.match(calls.at(-1), /from=2026-09-01&to=2026-09-15$/);
  assert.equal(doc.querySelector('[data-mp-range="custom"]').classList.contains('on'), true);
  const before = calls.length;
  doc.getElementById('mp-from').value = '2026-09-20';
  doc.getElementById('mp-filters').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(20);
  assert.equal(calls.length, before, '起訖顛倒不送查詢');
  assert.match(doc.getElementById('mp-status').textContent, /開始日期不能晚於結束日期/);
  dom.window.close();
  const linked = await openPage('https://crm.example/admin/message-performance?source=keyword&from=2026-09-01&to=2026-09-30');
  assert.equal(linked.doc.getElementById('mp-source').value, 'keyword');
  assert.match(linked.calls[0], /from=2026-09-01&to=2026-09-30&source=keyword$/);
  linked.dom.window.close();
});

test('點一列：顯示發送狀況、每個連結的點擊次數與人數，並可前往設定', async () => {
  const { dom, doc, calls } = await openPage();
  doc.querySelector('#mp-tbody tr.mp-row').click();
  await wait(30);
  const box = doc.querySelector('.mp-detail .mp-detail-box');
  assert.ok(box);
  assert.match(calls.at(-1), /\/messages\/detail\?type=broadcast&sourceId=90/);
  assert.match(box.textContent, /送出 4 次，LINE 拒絕 1 次/);
  const linkRow = [...box.querySelectorAll('tr')].find(tr => tr.querySelector('td'));
  assert.deepEqual([...linkRow.children].map(td => td.textContent), ['前往', 'https://example.com/a', '2', '1']);
  assert.match(box.textContent, /點擊次數點擊人數/);
  assert.match(box.textContent, /B 版沒有可追蹤的連結/);
  assert.equal(box.querySelector('a').getAttribute('href'), '/admin/broadcast/90');
  doc.querySelector('#mp-tbody tr.mp-row').click();
  assert.equal(doc.querySelectorAll('.mp-detail').length, 0, '再點一次收起');
  dom.window.close();
});

test('路由：新列表需要管理員、日期錯誤回 400、資料庫錯誤回 503', async () => {
  const { registerAdminMessagePerformance } = require('../src/routes/adminMessagePerformance');
  const routes = {};
  const app = { get(p, ...h) { routes[p] = h; } };
  let guarded = 0;
  registerAdminMessagePerformance(app, { query: async () => { throw new Error('db down'); }, authCore: { requireAdmin: (_q, _s, n) => { guarded++; n(); } } });
  const h = routes['/admin/message-performance/messages'];
  assert.ok(h && h.length === 2, '要有管理員檢查');
  const res = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const bad = res(); await h[1]({ query: { from: '2026/09/01', to: '2026-09-02' } }, bad);
  assert.equal(bad.code, 400);
  const down = res(); await h[1]({ query: { from: '2026-09-01', to: '2026-09-02' } }, down);
  assert.equal(down.code, 503);
  assert.equal(down.headers['Cache-Control'], 'no-store');
  assert.ok(routes['/admin/message-performance/messages/detail']);
  assert.ok(routes['/admin/message-performance/api'], '舊端點保留相容');
});


test('關鍵字 A/B 明細標記主要目標及同一觀察期，非主要連結不冒充 KPI', async () => {
  const { dom, doc } = await openPage(undefined, {detail: {ok:true,groups:[{variant:'a',links:[
    {label:'獎勵',uri:'https://example.com/a',clicks:2,people:1,primary:true},
    {label:'說明',uri:'https://example.com/help',clicks:1,people:1,primary:false}
  ]}]}});
  doc.querySelector('#mp-tbody tr.mp-row').click(); await wait(30);
  const box=doc.querySelector('.mp-detail-box');
  assert.match(box.textContent,/主要目標/); assert.match(box.textContent,/非主要目標/);
  assert.match(box.textContent,/觀察期/);
  dom.window.close();
});

test('新查詢失敗時不保留上次 KPI，搜尋也不把錯誤變成空資料', async () => {
  let fail=false;
  const {dom,w,doc}=await openPage(undefined,{list:()=>fail?{ok:false,error:'暫時不可用'}:{ok:true,rows:ROWS}});
  fail=true;doc.querySelector('[data-mp-range="7d"]').click();await wait(30);
  assert.doesNotMatch(doc.getElementById('mp-kpis').textContent,/5收到人數/);
  doc.getElementById('mp-q').value='foo';doc.getElementById('mp-q').dispatchEvent(new w.Event('input'));
  assert.match(doc.getElementById('mp-tbody').textContent,/讀取失敗/);
  dom.window.close();
});

test('尚未套用的新日期不會改變已顯示列表的明細統計期間', async () => {
  const {dom,doc,calls}=await openPage('https://crm.example/admin/message-performance?from=2026-10-08&to=2026-10-08');
  doc.getElementById('mp-from').value='2026-10-01';
  doc.querySelector('#mp-tbody tr.mp-row').click();await wait(30);
  assert.match(calls.at(-1),/from=2026-10-08&to=2026-10-08/);
  dom.window.close();
});

test('載入期間提交反向日期不會使原本有效查詢永遠停在載入中', async () => {
  let finish;
  const pending=new Promise(resolve=>{finish=resolve});
  const {dom,w,doc}=await openPage('https://crm.example/admin/message-performance?from=2026-10-08&to=2026-10-08',{list:()=>pending});
  doc.getElementById('mp-from').value='2026-10-09';
  doc.getElementById('mp-filters').dispatchEvent(new w.Event('submit',{cancelable:true}));
  finish({ok:true,rows:ROWS});await wait(30);
  assert.equal(doc.querySelectorAll('#mp-tbody tr.mp-row').length,3);
  assert.match(doc.getElementById('mp-status').textContent,/開始日期不能晚於結束日期/);
  dom.window.close();
});
