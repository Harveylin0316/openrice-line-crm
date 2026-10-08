'use strict';
// 發送時「排除先前 A/B 測試收到的人」：可勾選的批次卡片，看得出是哪一則訊息、哪種測試、幾個測試對象。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const SOURCES = [
  { id: 90, created_at: '2026-10-01T04:00:00Z', status: 'done', title: '中秋抽機票｜轉輪盤抽 26,000 哩', notification: '中秋限定', kind: 'campaign', test_count: 640 },
  { id: 85, created_at: '2026-09-20T04:00:00Z', status: 'done', title: '國慶連假訂位優惠', notification: '', kind: 'ab', test_count: 1200 }
];

async function open(opts = {}) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const previews = [];
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/exclusion-sources') return opts.fail ? { json: async () => ({ ok: false }) } : { json: async () => ({ ok: true, sources: SOURCES }) };
    if (url === '/admin/broadcast/audience/preview') { previews.push(JSON.parse(options.body || '{}')); return { json: async () => ({ ok: true, total: 10, users: [] }) }; }
    return { json: async () => ({ ok: true, recipients: [], templates: [], lists: [] }) };
  };
  window.eval(source);
  await wait(60);
  return { dom, window, doc: window.document, previews };
}

test('排除區預設收起、顯示「未排除」；舊的多選清單與裸露的編號欄位不再出現', async () => {
  const { dom, doc } = await open();
  const block = doc.getElementById('exclude-ab-block');
  assert.ok(block);
  assert.equal(block.open, false);
  assert.equal(doc.getElementById('exclude-ab-summary').textContent, '未排除');
  assert.equal(doc.getElementById('exclude-broadcast-picker'), null, '不再用要按 Cmd/Ctrl 才能複選的清單');
  assert.ok(doc.getElementById('exclude-broadcast-ids').closest('.ex-ab-more'), '編號輸入收進「找不到要的批次？」');
  assert.match(block.textContent, /收到 A、B、C 測試版本的人/);
  assert.match(block.textContent, /還沒收到訊息的人不受影響/);
  dom.window.close();
});

test('每個批次一張卡：訊息名稱、Campaign／A/B、日期、測試人數、編號；勾選即排除並更新摘要', async () => {
  const { dom, window, doc, previews } = await open();
  const items = [...doc.querySelectorAll('#exclude-ab-list .ex-ab-item')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /中秋抽機票｜轉輪盤抽 26,000 哩/);
  assert.match(items[0].textContent, /Campaign Testing/);
  assert.match(items[0].textContent, /測試對象 640 人 · #90/);
  assert.match(items[1].textContent, /A\/B 測試/);
  const cb = items[0].querySelector('input');
  cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.getElementById('exclude-broadcast-ids').value, '90');
  assert.equal(doc.getElementById('exclude-ab-summary').textContent, '已選 1 批，最多排除 640 人');
  assert.equal(doc.querySelector('#exclude-ab-list .ex-ab-item').classList.contains('on'), true);
  assert.equal(items[0].isConnected, true, '勾選不重畫清單（鍵盤焦點不會跳掉）');
  const cb2 = doc.querySelectorAll('#exclude-ab-list .ex-ab-item input')[1];
  cb2.checked = true; cb2.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.getElementById('exclude-broadcast-ids').value, '90, 85');
  assert.equal(doc.getElementById('exclude-ab-summary').textContent, '已選 2 批，最多排除 1,840 人');
  // 取消勾選
  const first = doc.querySelector('#exclude-ab-list .ex-ab-item input');
  first.checked = false; first.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.getElementById('exclude-broadcast-ids').value, '85');
  // 預覽收件人時把排除的批次帶給伺服器（沿用原本的條件格式）
  doc.getElementById('btn-preview-audience').click();
  await wait(40);
  assert.deepEqual(previews.at(-1).conditions.excludeBroadcastIds, ['85']);
  dom.window.close();
});

test('搜尋可依名稱或編號篩選；手動輸入舊批次編號會一起計入並勾選對應卡片', async () => {
  const { dom, window, doc } = await open();
  const s = doc.getElementById('exclude-ab-search');
  s.value = '國慶'; s.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('#exclude-ab-list .ex-ab-item').length, 1);
  s.value = '#90'; s.dispatchEvent(new window.Event('input'));
  assert.match(doc.getElementById('exclude-ab-list').textContent, /中秋抽機票/);
  s.value = '找不到的'; s.dispatchEvent(new window.Event('input'));
  assert.match(doc.getElementById('exclude-ab-list').textContent, /沒有符合搜尋的批次/);
  s.value = ''; s.dispatchEvent(new window.Event('input'));
  const ids = doc.getElementById('exclude-broadcast-ids');
  ids.value = '12, 90'; ids.dispatchEvent(new window.Event('input')); ids.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('exclude-ab-summary').textContent, '已選 2 批，最多排除 640 人（含 1 批手動輸入）');
  assert.equal(doc.querySelector('#exclude-ab-list input[value="90"]').checked, true);
  assert.equal(doc.getElementById('exclude-ab-block').open, true, '有排除時自動展開，避免忘記');
  dom.window.close();
});

test('批次清單載入失敗：提示改用輸入編號並自動展開輸入欄', async () => {
  const { dom, doc } = await open({ fail: true });
  assert.match(doc.getElementById('exclude-ab-list').textContent, /暫時無法載入批次清單/);
  assert.equal(doc.querySelector('#exclude-ab-block .ex-ab-more').open, true);
  dom.window.close();
});

test('伺服器：可排除的批次清單帶訊息名稱、類型與測試人數', async () => {
  const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  registerAdminBroadcastRoutes(app, {
    query: async () => ({ rows: [{ id: 90, created_at: '2026-10-01T04:00:00Z', status: 'done', is_ab_test: true, channel: 'line', test_count: 640,
      message_config: { mode: 'template', template: { title: '中秋抽機票', altText: '中秋限定', ctaLabel: '去', ctaUrl: 'https://example.com' } },
      variant_b_message_config: null, audience_config: { experiment: { enabled: true } } }] }),
    pool: {}, authCore: { requireAdmin: (_q, _s, n) => n() }, linePush: null, emailProvider: null, lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ''
  });
  const res = { json(b) { this.body = b; return this; }, status() { return this; } };
  await routes['GET /admin/broadcast/exclusion-sources'].at(-1)({}, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.assign({}, res.body.sources[0], { title: Boolean(res.body.sources[0].title) }),
    { id: 90, created_at: '2026-10-01T04:00:00Z', status: 'done', title: true, notification: '中秋限定', kind: 'campaign', test_count: 640 });
});
