'use strict';
// 手機 App 內建瀏覽器（LINE 等）會擋掉 window.confirm()：不顯示、直接回傳 false，
// 以前按「取消」什麼都不會發生、群發繼續送。現在改用網頁內的確認視窗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const HELPER = fs.readFileSync(path.join(REPO, 'public/crm-confirm.js'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));

function inAppBrowser(dom) {
  const w = dom.window;
  let nativeAsked = 0;
  w.confirm = () => { nativeAsked++; return false; };     // 模擬被擋：永遠回 false
  w.alert = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const posts = [];
  w.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') posts.push(String(url));
    return { json: async () => ({ ok: true, recipients: [], templates: [], lists: [], sources: [] }) };
  };
  w.eval(HELPER);
  return { w, posts, nativeAsked: () => nativeAsked };
}
async function clickConfirm(doc, label) {
  await wait(5);
  const overlay = doc.querySelector('.crm-confirm-overlay');
  assert.ok(overlay, '要出現網頁內的確認視窗');
  [...overlay.querySelectorAll('button')].find(b => b.textContent === label).click();
  await wait(20);
}

test('確認視窗：預設焦點在「先不要」、Esc 與點背景都會關閉並回 false、按確定回 true', async () => {
  const dom = new JSDOM('<!doctype html><body><button id="x">x</button></body>', { runScripts: 'outside-only' });
  const { w } = inAppBrowser(dom);
  const doc = w.document;
  let p = w.crmConfirm('確定？', { confirmText: '確定取消', danger: true });
  await wait(5);
  assert.equal(doc.activeElement.textContent, '先不要');
  assert.equal(doc.querySelector('.crm-confirm-overlay').getAttribute('role'), 'dialog');
  assert.ok(doc.querySelector('.crm-confirm-yes').classList.contains('danger'));
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await p, false);
  assert.equal(doc.querySelector('.crm-confirm-overlay'), null);
  p = w.crmConfirm('確定？');
  await wait(5);
  doc.querySelector('.crm-confirm-overlay').click();
  assert.equal(await p, false);
  p = w.crmConfirm('確定？');
  await wait(5);
  doc.querySelector('.crm-confirm-yes').click();
  assert.equal(await p, true);
  dom.window.close();
});

test('群發頁「執行中的批次」：手機內建瀏覽器按取消，會出現確認並真的送出取消', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true, prizes: [], activities: [], recent: [],
    scheduled: [], running: [{ id: 25, recipient_total: 3562, recipient_ok: 106, recipient_fail: 0, recipient_skip: 0, pending_count: 3456, started_at: '2026-10-09T14:40:00Z', created_at: '2026-10-09T14:40:00Z' }],
    hasLineToken: true, maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  assert.match(html, /\/crm-confirm\.js/, '版面要載入確認視窗');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://crm.example/admin/broadcast', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; } });
  await wait(80);
  const { w, posts, nativeAsked } = inAppBrowser(dom);
  const doc = w.document;
  doc.dispatchEvent(new w.Event('DOMContentLoaded'));
  await wait(20);
  const btn = doc.querySelector('.sched-row[data-id="25"] .sched-cancel-btn');
  assert.ok(btn, '執行中的批次有取消按鈕');
  btn.click();
  await clickConfirm(doc, '確定取消');
  assert.equal(nativeAsked(), 0, '不再使用會被擋掉的瀏覽器確認視窗');
  assert.ok(posts.includes('/admin/broadcast/25/cancel'), '真的送出取消');
  assert.equal(doc.querySelector('.sched-row[data-id="25"]'), null, '取消成功後那一行消失');
  dom.window.close();
});

test('其他三個取消按鈕（群發歷史、批次詳情的保留名單、送出當下）都不再呼叫瀏覽器 confirm()', () => {
  const files = ['views/admin_broadcast_history.ejs', 'views/admin_broadcast_detail.ejs', 'public/admin-broadcast.js', 'views/admin_broadcast.ejs'];
  files.forEach(f => {
    const s = fs.readFileSync(path.join(REPO, f), 'utf8');
    const rawCancel = s.split('\n').filter(l => /(?<![\w.])confirm\(/.test(l) && /取消|cancel/i.test(l));
    assert.deepEqual(rawCancel, [], f + ' 的取消不可再用 confirm()');
    assert.match(s, /crmConfirm\(/, f + ' 改用網頁內確認');
  });
});

test('送出當下的「取消這個批次」：成功時按鈕顯示已取消，失敗時跳出原因', async () => {
  const src = fs.readFileSync(path.join(REPO, 'public/admin-broadcast.js'), 'utf8');
  const i = src.indexOf("$('btn-cancel').addEventListener('click'");
  const block = src.slice(i, i + 1600);
  assert.match(block, /btn\.textContent = '已取消'/);
  assert.match(block, /剩下還沒送的人不會再收到/);
  assert.match(block, /最後一波最多 50 人可能仍會送出/);
  assert.match(block, /取消失敗：/);
});
