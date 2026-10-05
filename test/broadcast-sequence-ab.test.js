'use strict';
// 多段訊息（訊息庫的文字＋圖文、Carousel 等）也能 A/B：B 版沿用 A 版每一段，只改要測的部分。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
const { buildLineMessages, listBroadcastButtons, resolveBroadcastButtonTarget } = require('../src/core/broadcastTemplates');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

function card(title, uri) {
  return {
    type: 'flex', altText: title + '｜通知',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: title }, { type: 'text', text: '活動說明' }] },
      footer: { type: 'box', layout: 'vertical', contents: uri ? [{ type: 'button', action: { type: 'uri', label: '馬上玩', uri } }] : [] }
    }
  };
}
const SEQUENCE = {
  mode: 'sequence',
  items: [
    { type: 'text', text: '哈囉，分享超有哩開跑了' },
    { type: 'image', originalContentUrl: 'https://img.example/a.jpg', previewImageUrl: 'https://img.example/a.jpg' },
    { type: 'card', source_message_id: 9, message_config: { mode: 'flex_json', flex: card('中秋抽機票', 'https://liff.line.me/L/wheel/share-miles') } }
  ]
};

const LIB = [
  { id: 42, name: '文字＋圖文訊息', mode: 'sequence' },
  { id: 51, name: '國慶抽機票卡片', mode: 'flex_json' },
  { id: 52, name: '一般優惠卡', mode: 'template' }
];
const LIB_ITEMS = {
  51: { id: 51, name: '國慶抽機票卡片', message_config: { mode: 'flex_json', flex: card('國慶抽機票', 'https://liff.line.me/L/wheel/national-day') } },
  52: { id: 52, name: '一般優惠卡', message_config: { mode: 'template', template: { title: '滿千折百', subtitle: '限本週', ctaLabel: '領券', ctaUrl: 'https://example.com/c', altText: '滿千折百', heroMediaId: 'm-52' } } }
};
async function openWithSequence(opts = {}) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const previews = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast?tpl=42', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, options = {}) => {
    if (opts.fetchOverride) {
      const override = opts.fetchOverride(url, options);
      if (override) return override;
    }
    if (url === '/admin/broadcast/test-recipients') return { json: async () => ({ ok: true, recipients: [] }) };
    if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: LIB.map(x=>({...x,message_config:LIB_ITEMS[x.id]?.message_config})) }) };
    if (url === '/admin/broadcast/templates/42') return { json: async () => ({ ok: true, template: { id: 42, name: '文字＋圖文訊息', message_config: opts.aConfig || SEQUENCE } }) };
    const m = /^\/admin\/broadcast\/templates\/(\d+)$/.exec(url);
    if (m && LIB_ITEMS[m[1]]) return { json: async () => ({ ok: true, template: LIB_ITEMS[m[1]] }) };
    if (url === '/admin/broadcast/hero/upload') return { json: async () => ({ ok: true, mediaId: 'up-1', url: 'https://crm.example/p/line-media/up-1' }) };
    if (url === '/admin/broadcast/preview-message') {
      previews.push(JSON.parse(options.body || '{}').message_config);
      return { json: async () => ({ ok: true, channel: 'line', messages: [{ type: 'text', text: 'x' }] }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  if (opts.draft) window.localStorage.setItem('broadcast_draft_v1', JSON.stringify(opts.draft));
  window.eval(source);
  await wait(900);
  return { dom, window, doc: window.document, previews };
}

test('A 換短素材後 B/C 草稿獨立還原，額外段落不提供不存在的 A 還原且圖片仍可上傳', async () => {
  let aConfig = SEQUENCE;
  const page = await openWithSequence({ fetchOverride: url => url === '/admin/broadcast/templates/42' ? { json: async () => ({ ok: true, template: { id: 42, name: 'A', message_config: aConfig } }) } : null });
  const { doc, window } = page;
  doc.getElementById('campaign-test-enable').checked = true;
  doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
  doc.getElementById('campaign-variant-count').value = '3';
  doc.getElementById('campaign-variant-count').dispatchEvent(new window.Event('change'));
  for (const key of ['b', 'c']) {
    const text = doc.querySelector('#pane-' + key + '-sequence textarea');
    text.value = key.toUpperCase() + ' 保留';
    text.dispatchEvent(new window.Event('input'));
  }
  aConfig = { mode: 'sequence', items: [{ type: 'text', text: '新 A 一段' }] };
  const select = doc.getElementById('template-select');
  select.value = '42'; select.dispatchEvent(new window.Event('change'));
  await wait(700);
  const saved = JSON.parse(window.localStorage.getItem('broadcast_draft_v1'));
  assert.equal(saved.sequenceConfig.items.length, 1);
  for (const key of ['b', 'c']) {
    const pane = doc.getElementById('pane-' + key + '-sequence');
    assert.equal(pane.querySelectorAll('.seq-var-item').length, 3);
    assert.equal(pane.querySelector('[data-seq-item-reset="2"]'), null);
    assert.ok(pane.querySelector('[data-seq-upload-btn="1"]'));
    assert.equal(pane.querySelector('.seq-var-state').textContent, '已修改，與 A 版不同');
  }
  const restored = await openWithSequence({ aConfig, draft: saved });
  for (const key of ['b', 'c']) {
    const pane = restored.doc.getElementById('pane-' + key + '-sequence');
    assert.equal(pane.querySelectorAll('.seq-var-item').length, 3);
    assert.equal(pane.querySelector('textarea').value, key.toUpperCase() + ' 保留');
  }
  assert.ok(restored.previews.some(cfg => cfg?.items?.[0]?.text === 'B 保留' && cfg.items.length === 3));
  doc.querySelector('[data-seq-reset="b"]').click();
  assert.equal(doc.querySelectorAll('#pane-b-sequence .seq-var-item').length, 1);
  assert.equal(doc.querySelector('#pane-b-sequence textarea').value, '新 A 一段');
  page.dom.window.close(); restored.dom.window.close();
});

test('A 比 B 段數多也保留 B 獨立草稿，無效段落不還原', async () => {
  const draft = {
    mode: 'sequence', abEnabled: true, sequenceConfig: SEQUENCE,
    seqVariants: { b: { mode: 'sequence', items: [{ type: 'text', text: '獨立短 B' }] } },
    seqVariantsEdited: { b: false }
  };
  const page = await openWithSequence({ draft });
  assert.equal(page.doc.querySelectorAll('#pane-b-sequence .seq-var-item').length, 1);
  assert.equal(page.doc.querySelector('#pane-b-sequence textarea').value, '獨立短 B');
  assert.equal(page.doc.querySelector('#pane-b-sequence .seq-var-state').textContent, '已修改，與 A 版不同');
  page.dom.window.close();
  draft.seqVariants.b.items = [null];
  const invalid = await openWithSequence({ draft });
  assert.equal(invalid.doc.querySelectorAll('#pane-b-sequence .seq-var-item').length, 3);
  invalid.dom.window.close();
});

test('多段訊息開 A/B：B 版逐段沿用 A 版，可改文字、圖片、卡片內文字與按鈕；改過的欄位標示出來', async () => {
  const { dom, window, doc, previews } = await openWithSequence();
  assert.equal(doc.getElementById('message-testing-settings').hidden, false, '多段訊息也要看得到 A/B 設定');
  const ab = doc.getElementById('ab-test-enable');
  ab.checked = true;
  ab.dispatchEvent(new window.Event('change'));
  await wait(50);
  const pane = doc.getElementById('pane-b-sequence');
  assert.equal(pane.hidden, false);
  assert.equal(doc.getElementById('pane-b-template').hidden, true, '多段訊息不顯示單張卡片的 B 版欄位');
  const items = pane.querySelectorAll('.seq-var-item');
  assert.equal(items.length, 3);
  const firstText = items[0].querySelector('textarea');
  assert.equal(firstText.value, '哈囉，分享超有哩開跑了');
  // 卡片：通知預覽文字、2 段卡片文字、按鈕文字、按鈕連結
  const cardLabels = [...items[2].querySelectorAll('.seq-var-field')].map(l => l.firstChild.textContent);
  assert.deepEqual(cardLabels, ['通知預覽文字', '卡片文字 1', '卡片文字 2', '按鈕 1 文字', '按鈕 1 連結']);
  assert.equal(pane.querySelectorAll('.seq-var-item.changed').length, 0);
  assert.equal(window.getComputedStyle(items[0].querySelector('[data-seq-item-reset]')).display, 'none');

  firstText.value = '最後 3 天！分享超有哩抽 26,000 哩';
  firstText.dispatchEvent(new window.Event('input'));
  const imgInput = items[1].querySelector('input[type="text"]');
  imgInput.value = 'https://img.example/b.jpg';
  imgInput.dispatchEvent(new window.Event('input'));
  await wait(700);

  assert.equal(items[0].classList.contains('changed'), true);
  assert.equal(items[0].querySelector('[data-seq-item-reset]').hidden, false, '改文字後立即提供單段還原');
  assert.match(items[0].textContent, /已修改/);
  assert.equal(items[2].classList.contains('changed'), false, '沒改的段落不標示');
  assert.equal(pane.querySelector('.seq-var-state').textContent, '已修改，與 A 版不同');
  const b = previews.find(p => p && p.items && p.items[0].text.startsWith('最後 3 天'));
  assert.ok(b, 'B 版預覽要送出改過的內容');
  assert.equal(b.mode, 'sequence');
  assert.equal(b.items.length, 3);
  assert.equal(b.items[1].originalContentUrl, 'https://img.example/b.jpg');
  assert.equal(b.items[1].previewImageUrl, 'https://img.example/b.jpg', '預覽圖原本跟原圖同一張就一起換');
  assert.deepEqual(b.items[2], SEQUENCE.items[2], '沒改的卡片原封不動');
  const a = previews.find(p => p && p.items && p.items[0].text === '哈囉，分享超有哩開跑了');
  assert.ok(a, 'A 版保持原樣');

  pane.querySelector('[data-seq-reset="b"]').click();
  await wait(20);
  assert.equal(doc.getElementById('pane-b-sequence').querySelector('textarea').value, '哈囉，分享超有哩開跑了');
  assert.equal(doc.querySelectorAll('#pane-b-sequence .seq-var-item.changed').length, 0);
  assert.equal(doc.querySelector('#pane-b-sequence .seq-var-state').textContent, '目前與 A 版相同');
  dom.window.close();
});

test('Campaign Testing 三版：C 版也用同一種編輯區，且改 B 不影響 C', async () => {
  const { dom, window, doc } = await openWithSequence();
  doc.getElementById('campaign-test-enable').checked = true;
  doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
  doc.getElementById('campaign-variant-count').value = '3';
  doc.getElementById('campaign-variant-count').dispatchEvent(new window.Event('change'));
  await wait(50);
  assert.equal(doc.getElementById('ab-test-enable').checked, true);
  assert.equal(doc.getElementById('ab-variant-b-allocation').textContent, '（10% 收件人）', '不能把小樣本實驗誤標成 50%');
  assert.equal(doc.getElementById('pane-c-sequence').hidden, false);
  assert.equal(doc.getElementById('pane-c-sequence').querySelectorAll('.seq-var-item').length, 3);
  const bText = doc.querySelector('#pane-b-sequence textarea');
  bText.value = 'B 版開頭';
  bText.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelector('#pane-c-sequence textarea').value, '哈囉，分享超有哩開跑了');
  dom.window.close();
});

test('同樣文案、換圖文卡片：B 版第 2 段可整張換成訊息庫的其他卡片（只列單張卡片），也能單段恢復', async () => {
  const { dom, window, doc, previews } = await openWithSequence();
  doc.getElementById('ab-test-enable').checked = true;
  doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change'));
  await wait(60);
  // 多段訊息不顯示「從訊息庫套用到版本 B」（那是單張卡片用的），要真的藏起來
  assert.equal(window.getComputedStyle(doc.getElementById('b-lib-row')).display, 'none');
  const swap = doc.querySelector('#pane-b-sequence [data-seq-swap="2"]');
  assert.ok(swap, '卡片段要有「整張換成」選單');
  const optionNames = [...swap.options].map(o => o.textContent);
  assert.ok(optionNames.some(t => /國慶抽機票卡片/.test(t)));
  assert.ok(optionNames.some(t => /一般優惠卡/.test(t)));
  assert.ok(!optionNames.some(t => /文字＋圖文訊息/.test(t)), '多段訊息不能塞進單一段');
  swap.value = '51';
  swap.dispatchEvent(new window.Event('change'));
  await wait(700);
  const items = doc.querySelectorAll('#pane-b-sequence .seq-var-item');
  assert.match(items[2].textContent, /已換成訊息庫素材「國慶抽機票卡片」/);
  assert.equal(items[0].classList.contains('changed'), false, '文案那段保持不變');
  const b = previews.filter(p => p && p.items).pop();
  assert.equal(b.items[0].text, '哈囉，分享超有哩開跑了');
  assert.equal(b.items[2].source_message_id, 51);
  assert.equal(b.items[2].message_config.flex.contents.body.contents[0].text, '國慶抽機票');
  // 換過的卡片欄位跟著新卡片
  const labels = [...items[2].querySelectorAll('.seq-var-field textarea, .seq-var-field input')].map(e => e.value);
  assert.ok(labels.includes('國慶抽機票'));
  // 單段恢復
  items[2].querySelector('[data-seq-item-reset="2"]').click();
  await wait(30);
  assert.equal(doc.querySelectorAll('#pane-b-sequence .seq-var-item.changed').length, 0);
  dom.window.close();
});

test('換圖：B 版圖片段可直接上傳新圖片，原圖與預覽圖一起換', async () => {
  const { dom, window, doc, previews } = await openWithSequence();
  doc.getElementById('ab-test-enable').checked = true;
  doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change'));
  await wait(60);
  const input = doc.querySelector('#pane-b-sequence [data-seq-upload="1"]');
  const file = new window.File(['x'], 'new.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new window.Event('change'));
  await wait(700);
  const b = previews.filter(p => p && p.items).pop();
  assert.equal(b.items[1].originalContentUrl, 'https://crm.example/p/line-media/up-1');
  assert.equal(b.items[1].previewImageUrl, 'https://crm.example/p/line-media/up-1');
  assert.equal(doc.querySelectorAll('#pane-b-sequence .seq-var-item')[1].classList.contains('changed'), true);
  dom.window.close();
});

for (const operation of ['card', 'image']) {
  test('非同步' + operation + '回應不能覆蓋已還原的 B 版', async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const pendingUrl = operation === 'card' ? '/admin/broadcast/templates/51' : '/admin/broadcast/hero/upload';
    const { dom, window, doc, previews } = await openWithSequence({
      fetchOverride: url => url === pendingUrl ? pending : null
    });
    doc.getElementById('ab-test-enable').checked = true;
    doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change'));
    await wait(60);
    if (operation === 'card') {
      const swap = doc.querySelector('#pane-b-sequence [data-seq-swap="2"]');
      swap.value = '51';
      swap.dispatchEvent(new window.Event('change'));
    } else {
      const input = doc.querySelector('#pane-b-sequence [data-seq-upload="1"]');
      Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'new.jpg', { type: 'image/jpeg' })] });
      input.dispatchEvent(new window.Event('change'));
    }
    doc.querySelector('#pane-b-sequence [data-seq-reset]').click();
    complete({ json: async () => operation === 'card'
      ? { ok: true, template: LIB_ITEMS[51] }
      : { ok: true, url: 'https://crm.example/p/line-media/late' } });
    await wait(700);
    assert.equal(doc.querySelectorAll('#pane-b-sequence .seq-var-item.changed').length, 0);
    assert.deepEqual(previews.filter(p => p && p.mode === 'sequence').pop(), SEQUENCE);
    dom.window.close();
  });
}

test('單張卡片的 A 版：B 版「從訊息庫套用」只列同格式素材，套用後填進 B 版編輯區', async () => {
  const flexA = { mode: 'flex_json', flex: card('中秋抽機票', 'https://liff.line.me/L/wheel/share-miles') };
  const { dom, window, doc } = await openWithSequence({ aConfig: flexA });
  doc.getElementById('ab-test-enable').checked = true;
  doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change'));
  await wait(80);
  assert.equal(doc.getElementById('b-lib-row').hidden, false);
  const sel = doc.getElementById('b-lib-select');
  const names = [...sel.options].map(o => o.textContent);
  assert.ok(names.some(t => /國慶抽機票卡片（自訂卡片）/.test(t)));
  assert.ok(!names.some(t => /一般優惠卡/.test(t)), 'A 是自訂卡片，不列一般卡片');
  assert.ok(!names.some(t => /文字＋圖文/.test(t)));
  sel.value = '51';
  sel.dispatchEvent(new window.Event('change'));
  await wait(50);
  assert.match(doc.getElementById('b-flex-json').value, /國慶抽機票/);
  assert.match(doc.getElementById('b-lib-status').textContent, /已套用「國慶抽機票卡片」/);
  assert.equal(doc.getElementById('pane-b-sequence').hidden, true);
  dom.window.close();
});

test('單張卡片快速套用 B 版素材，較慢的舊回應不得覆蓋最後一次選擇', async () => {
  let complete, calls = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const flexA = { mode: 'flex_json', flex: card('原始 A', 'https://example.com/a') };
  const latest = { id: 51, name: '最後選擇', message_config: { mode: 'flex_json', flex: card('最後選擇', 'https://example.com/latest') } };
  const { dom, window, doc } = await openWithSequence({ aConfig: flexA,
    fetchOverride: url => url === '/admin/broadcast/templates/51'
      ? (++calls === 1 ? pending : { json: async () => ({ ok: true, template: latest }) }) : null
  });
  try {
    doc.getElementById('ab-test-enable').checked = true;
    doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change'));
    await wait(80);
    const sel = doc.getElementById('b-lib-select');
    for (let i = 0; i < 2; i++) {
      sel.value = '51';
      sel.dispatchEvent(new window.Event('change'));
      await wait(30);
    }
    assert.match(doc.getElementById('b-flex-json').value, /最後選擇/);
    complete({ json: async () => ({ ok: true, template: LIB_ITEMS[51] }) });
    await wait(80);
    assert.match(doc.getElementById('b-flex-json').value, /最後選擇/);
  } finally { dom.window.close(); }
});

test('較慢的舊預覽不得覆蓋新內容；最新預覽失敗時不得沿用可發送狀態', async () => {
  let complete, active = false;
  const pending = new Promise(resolve => { complete = resolve; });
  const { dom, window, doc } = await openWithSequence({
    aConfig: { mode: 'template', template: { title: '初始', ctaLabel: '前往', ctaUrl: 'https://example.com', altText: '通知' } },
    fetchOverride: (url, options) => {
      if (url === '/admin/broadcast/audience/preview') return { json: async () => ({ ok: true, total: 1, users: [] }) };
      if (!active || url !== '/admin/broadcast/preview-message') return null;
      const title = JSON.parse(options.body).message_config.template.title;
      if (title === '舊內容') return pending;
      if (title === '網路故障') return Promise.reject(new Error('offline'));
      return { json: async () => ({ ok: true, messages: [{ type: 'text', text: title }] }) };
    }
  });
  try {
    doc.getElementById('btn-preview-audience').click();
    await wait(80);
    assert.equal(doc.getElementById('btn-send').classList.contains('btn-needs-prep'), false);
    active = true;
    const title = doc.getElementById('tpl-title');
    title.value = '舊內容'; title.dispatchEvent(new window.Event('input'));
    assert.equal(doc.getElementById('btn-send').classList.contains('btn-needs-prep'), true, '修改後立即停止沿用舊的預覽通過狀態');
    await wait(600);
    title.value = '新內容'; title.dispatchEvent(new window.Event('input'));
    await wait(650);
    assert.match(doc.getElementById('msg-preview').textContent, /新內容/);
    complete({ json: async () => ({ ok: true, messages: [{ type: 'text', text: '舊內容' }] }) });
    await wait(80);
    assert.match(doc.getElementById('msg-preview').textContent, /新內容/);
    title.value = '網路故障'; title.dispatchEvent(new window.Event('input'));
    await wait(650);
    assert.match(doc.getElementById('msg-status').textContent, /網路錯誤/);
    assert.equal(doc.getElementById('btn-send').classList.contains('btn-needs-prep'), true, '網路失敗時不可送出');
  } finally { dom.window.close(); }
});

// ---------- 伺服器：建立批次 ----------
function harness(opts = {}) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  const audience = [1, 2, 3, 4].map(i => ({ user_id: i, line_user_id: 'U' + String(i).repeat(32) }));
  const inserted = [];
  const exec = async (sql, params = []) => {
    const c = String(sql).replace(/\s+/g, ' ');
    if (/COUNT\(DISTINCT u\.id\)/.test(c)) return { rows: [{ total: audience.length }], rowCount: 1 };
    if (/SELECT u\.id AS user_id, u\.line_user_id/.test(c)) return { rows: audience.slice(), rowCount: audience.length };
    if (/SELECT u\.id, u\.line_user_id/.test(c)) return { rows: audience.map(a => ({ id: a.user_id, line_user_id: a.line_user_id })), rowCount: audience.length };
    if (/INSERT INTO admin_broadcasts/.test(c)) { inserted.push(params); return { rows: [{ id: 77 }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  registerAdminBroadcastRoutes(app, {
    query: exec, pool: { connect: async () => ({ query: exec, release() {} }) },
    authCore: { requireAdmin: (_q, _s, n) => n() },
    linePush: { validatePushMessages: opts.validate || (async () => ({ ok: true })), pushLineMessages: async () => true },
    emailProvider: { isConfigured: () => false }, lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://crm.example'
  });
  return { routes, inserted };
}
async function create(body, opts) {
  const { routes, inserted } = harness(opts);
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { body, params: {}, query: {}, authUser: { uid: 1, un: 'admin' }, get: () => 'crm.example' };
  for (const h of routes['POST /admin/broadcast/create']) {
    let next = false;
    await h(req, res, () => { next = true; });
    if (!next) break;
  }
  return { res, inserted };
}
const withB = (text) => {
  const b = JSON.parse(JSON.stringify(SEQUENCE));
  b.items[0].text = text;
  return b;
};

test('伺服器：多段訊息 A/B 可以建立批次，B 版以多段訊息存下', async () => {
  const { res, inserted } = await create({
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: SEQUENCE, ab_test: true, variant_b_message_config: withB('B 版開頭')
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  const params = inserted[0];
  const stored = params.map(p => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(Boolean);
  assert.ok(stored.some(v => v.mode === 'sequence' && v.items && v.items[0].text === 'B 版開頭'), 'B 版存成多段訊息');
});

test('伺服器：Campaign Testing 可用多段訊息；每個版本都要有開啟網址的按鈕', async () => {
  const experiment = { enabled: true, variant_count: 2, observation_hours: 24, metric: 'ctr', allocations: { a: 10, b: 10, c: 0, holdout: 80 } };
  const ok = await create({
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: SEQUENCE, ab_test: true, variant_b_message_config: withB('B 版開頭'), campaign_experiment: experiment
  });
  assert.equal(ok.res.statusCode, 200, JSON.stringify(ok.res.body));
  assert.equal(ok.res.body.ok, true, JSON.stringify(ok.res.body));

  const noButton = JSON.parse(JSON.stringify(SEQUENCE));
  noButton.items[2].message_config.flex = card('沒有按鈕的卡片', null);
  const bad = await create({
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: SEQUENCE, ab_test: true, variant_b_message_config: noButton, campaign_experiment: experiment
  });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.res.body.error, 'campaign_experiment_requires_cta_button');
});

test('伺服器：A/B/C 多段訊息與保留名單成功建立，C 版完整保存', async () => {
  const { res, inserted } = await create({
    channel: 'line', conditions: { allMembers: true }, message_config: SEQUENCE,
    variant_b_message_config: withB('B'), variant_c_message_config: withB('C'),
    campaign_experiment: { enabled: true, variant_count: 3, observation_hours: 24,
      metric: 'ctr', allocations: { a: 10, b: 10, c: 10, holdout: 70 } }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.variantCounts, { a: 1, b: 1, c: 1, holdout: 1 });
  const config = JSON.parse(inserted[0][1]);
  assert.deepEqual(config.experiment.variantCMessageConfig, withB('C'));
  assert.equal(config.experiment.winnerAt, null, '等測試發送完才開始觀察，不提前發保留名單');
});

for (const version of ['a', 'b', 'c']) {
  test('Campaign Testing 擋下版本 ' + version + ' 無 CTA 的一般卡片', async () => {
    const configs = { a: SEQUENCE, b: withB('B'), c: withB('C') };
    configs[version] = { mode: 'template', template: { title: '沒有 CTA 的卡片' } };
    const { res, inserted } = await create({
      channel: 'line', conditions: { allMembers: true }, message_config: configs.a,
      variant_b_message_config: configs.b, variant_c_message_config: configs.c,
      campaign_experiment: { enabled: true, variant_count: 3, observation_hours: 24,
        metric: 'ctr', allocations: { a: 10, b: 10, c: 10, holdout: 70 } }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'campaign_experiment_requires_cta_button');
    assert.equal(inserted.length, 0, '不能建立永遠無法產生 CTA 點擊的實驗');
  });
}

test('多段訊息各版本保留文字／卡片順序，跨卡片 CTA 追蹤序號可反查目的地', () => {
  for (const version of ['a', 'b', 'c']) {
    const config = withB(version);
    config.items.push({ type: 'card', message_config: {
      mode: 'flex_json', flex: card('另一張卡', 'https://example.com/' + version)
    } });
    const options = { heroImageBaseUrl: 'https://crm.example', broadcastId: 77, recipientId: 11, variant: version };
    const result = buildLineMessages(config, options);
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages.map(m => m.type), ['text', 'image', 'flex', 'flex']);
    assert.equal(result.messages[0].text, version);
    assert.equal(result.messages[2].contents.footer.contents[0].action.uri, 'https://crm.example/r/b/77/11/0?v=' + version);
    assert.equal(result.messages[3].contents.footer.contents[0].action.uri, 'https://crm.example/r/b/77/11/1?v=' + version);
    const buttons = listBroadcastButtons(config, options);
    assert.equal(buttons.length, 2);
    assert.equal(resolveBroadcastButtonTarget(config, 1, options).uri, 'https://example.com/' + version);
    assert.equal(config.items[3].message_config.flex.contents.footer.contents.length, 1, '追蹤 pixel 不污染原素材');
  }
});

const SHARED_IMAGE = '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b';
function richConfig(variant) { return {mode:'imagemap',imagemap:{assetId:SHARED_IMAGE,baseWidth:1040,baseHeight:780,altText:'STAGING '+variant,areas:[{type:'uri',uri:'https://example.com/?variant='+variant+'&utm_source=staging',x:0,y:0,width:1040,height:780}]}}; }
test('same-image imagemaps remain distinct assets; each slot has same-type replacements; B test send is independent',async()=>{
 const a={mode:'sequence',items:[{type:'text',text:'STAGING A'},{type:'card',source_message_id:61,source_name:'STAGING map A',message_config:richConfig('a')}]};
 const assets=[{id:42,name:'STAGING sequence',mode:'sequence',message_config:a},{id:61,name:'STAGING map A',mode:'imagemap',message_config:richConfig('a')},{id:62,name:'STAGING map B',mode:'imagemap',message_config:richConfig('b')},{id:63,name:'STAGING texts',mode:'sequence',message_config:{mode:'sequence',items:[{type:'text',text:'STAGING B'},{type:'image',originalContentUrl:'https://example.com/x.jpg'}]}}];
 const sends=[];
 const {dom,window,doc,previews}=await openWithSequence({aConfig:a,fetchOverride:(url,options)=>{
 if(url==='/admin/broadcast/templates')return {json:async()=>({ok:true,templates:assets})};
 if(url==='/admin/broadcast/test-push'){sends.push(JSON.parse(options.body));return {json:async()=>({ok:true})};}
 const found=assets.find(x=>url==='/admin/broadcast/templates/'+x.id);if(found)return {json:async()=>({ok:true,template:found})};
 }});
 try{
 doc.querySelector('#ab-test-enable').checked=true;doc.querySelector('#ab-test-enable').dispatchEvent(new window.Event('change'));await wait(80);
 const text=doc.querySelector('#pane-b-sequence [data-seq-swap="0"]');assert.ok(text);assert.ok([...text.options].some(x=>x.textContent.includes('STAGING texts')));
 const picker=doc.querySelector('#pane-b-sequence [data-seq-swap="1"]');assert.ok([...picker.options].some(x=>x.value==='62'));assert.ok(![...picker.options].some(x=>x.textContent.includes('STAGING texts')));
 picker.value='62';picker.dispatchEvent(new window.Event('change'));await wait(700);
 assert.match(doc.querySelector('#pane-b-sequence').textContent,/STAGING map B/);
 const b=previews.filter(x=>x?.items?.[1]?.source_message_id===62).pop();assert.ok(b);
 assert.equal(b.items[1].message_config.imagemap.areas[0].uri,'https://example.com/?variant=b&utm_source=staging');
 assert.equal(a.items[1].message_config.imagemap.areas[0].uri,'https://example.com/?variant=a&utm_source=staging');
 assert.equal(doc.querySelector('#test-campaign-variant-wrap').hidden,false);
 doc.querySelector('#test-campaign-variant').value='b';doc.querySelector('#btn-test-push').click();await wait(40);
 assert.equal(sends[0].message_config.items[1].source_message_id,62);
 const aSelect=doc.querySelector('#template-select');
 a.items[0].text='STAGING changed A';
 aSelect.value='42';aSelect.dispatchEvent(new window.Event('change'));await wait(700);
 assert.match(doc.querySelector('#pane-b-sequence').textContent,/STAGING map B/);
 assert.equal(doc.querySelector('#pane-b-sequence textarea').value,'STAGING A');

 for(const [variant,cfg] of [['a',a],['b',b]]){
  const built=buildLineMessages(cfg,{heroImageBaseUrl:'https://staging.example',broadcastId:22,recipientId:1,variant});assert.equal(built.ok,true);
  assert.equal(resolveBroadcastButtonTarget(cfg,0,{heroImageBaseUrl:'https://staging.example'}).uri,'https://example.com/?variant='+variant+'&utm_source=staging');
 }
 }finally{dom.window.close();}
});

test('same-type catalog separates flex/carousel and offers text/image/video segments by message ID and slot',async()=>{
 const carousel={mode:'flex_json',flex:{type:'flex',altText:'STAGING carousel',contents:{type:'carousel',contents:[card('STAGING','https://example.com').contents]}}};
 const cfg={mode:'sequence',items:[{type:'text',text:'STAGING'},{type:'image',originalContentUrl:'https://example.com/x.jpg'},{type:'video',originalContentUrl:'https://example.com/x.mp4',previewImageUrl:'https://example.com/x.jpg'},{type:'card',message_config:LIB_ITEMS[51].message_config},{type:'card',message_config:carousel}]};
 const assets=[{id:42,name:'STAGING slots',mode:'sequence',message_config:cfg},{id:80,name:'STAGING carousel',mode:'flex_json',message_config:carousel},{...LIB_ITEMS[51],mode:'flex_json'},{id:'\"><img id=bad-asset>',name:'bad',mode:'flex_json',message_config:carousel}];
 const {dom,window,doc}=await openWithSequence({aConfig:cfg,fetchOverride:url=>url==='/admin/broadcast/templates'?{json:async()=>({ok:true,templates:assets})}:null});
 try{
 doc.querySelector('#ab-test-enable').checked=true;doc.querySelector('#ab-test-enable').dispatchEvent(new window.Event('change'));await wait(80);
 for(let i=0;i<5;i++){
 const values=[...doc.querySelector('#pane-b-sequence [data-seq-swap="'+i+'"]').options].map(o=>o.value);
 assert.ok(values.includes('42:'+i));assert.ok(!values.includes('42:'+((i+1)%5)));
 if(i===3){assert.ok(values.includes('51'));assert.ok(!values.includes('80'));}
 if(i===4){assert.ok(values.includes('80'));assert.ok(!values.includes('51'));}
 }
 assert.equal(doc.querySelector('#bad-asset'),null);
 }finally{dom.window.close();}
});
test('formal A/B batch stores separate same-image imagemap snapshots and their tracking targets',async()=>{
 const a={mode:'sequence',items:[{type:'text',text:'STAGING A'},{type:'card',source_message_id:61,message_config:richConfig('a')}]};
 const b={mode:'sequence',items:[{type:'text',text:'STAGING B'},{type:'card',source_message_id:62,message_config:richConfig('b')}]};
 const {res,inserted}=await create({channel:'line',send_mode:'immediate',conditions:{allMembers:true},message_config:a,ab_test:true,variant_b_message_config:b});
 assert.equal(res.body.ok,true,JSON.stringify(res.body));
 const stored=inserted[0].map(p=>{try{return JSON.parse(p);}catch{return null;}}).filter(p=>p?.mode==='sequence');
 assert.equal(stored.length,2);
 for(const [i,version] of ['a','b'].entries()){
 assert.equal(stored[i].items[1].source_message_id,i===0?61:62);
 const payload=buildLineMessages(stored[i],{heroImageBaseUrl:'https://staging.example',broadcastId:77,recipientId:1,variant:version});
 assert.equal(payload.ok,true);assert.deepEqual(payload.messages.map(m=>m.type),['text','imagemap']);
 assert.match(payload.messages[1].actions[0].linkUri,new RegExp('v='+version));
 assert.equal(resolveBroadcastButtonTarget(stored[i],0,{heroImageBaseUrl:'https://staging.example'}).uri,'https://example.com/?variant='+version+'&utm_source=staging');
 }
});

test('actual shared sender keeps same-image A/B native payloads and UTM URLs',async()=>{
 const {createLinePushService}=require('../src/core/linePush');
 const originalFetch=global.fetch, requests=[];
 global.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,status:200};};
 try{
  const sender=createLinePushService({lineChannelAccessToken:'STAGING_TEST_TOKEN',query:async()=>({rows:[]})});
  for(const version of ['a','b']){
   const cfg={mode:'sequence',items:[{type:'text',text:'STAGING '+version},{type:'card',message_config:richConfig(version)}]};
   const built=buildLineMessages(cfg,{heroImageBaseUrl:'https://staging.example'});
   assert.equal(await sender.pushLineMessages('U'+'0'.repeat(32),built.messages),true);
  }
  assert.equal(requests[0].messages[1].baseUrl,requests[1].messages[1].baseUrl);
  for(const [i,v] of ['a','b'].entries())assert.equal(requests[i].messages[1].actions[0].linkUri,'https://example.com/?variant='+v+'&utm_source=staging');
 }finally{global.fetch=originalFetch;}
});

test('Campaign Testing：文字＋滿版圖文的多段訊息可以通過送出前檢查（以前被誤擋成「進階 Flex JSON」）', async () => {
  const IMAGEMAP_SEQ = { mode: 'sequence', items: [
    { type: 'text', text: 'STAGING 文字' },
    { type: 'card', source_message_id: 71, source_name: 'STAGING Imagemap A', message_config: { mode: 'imagemap', imagemap: {
      assetId: '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b', baseWidth: 1040, baseHeight: 1040, altText: 'STAGING', layout: 'full',
      areas: [{ type: 'uri', uri: 'https://example.com/?variant=a', x: 0, y: 0, width: 1040, height: 1040 }] } } }] };
  const alerts = [];
  const { dom, window, doc } = await openWithSequence({
    aConfig: IMAGEMAP_SEQ,
    fetchOverride: (url) => url === '/admin/broadcast/audience/preview' ? { json: async () => ({ ok: true, total: 20, users: [] }) } : null
  });
  try {
    window.alert = (m) => alerts.push(String(m));
    doc.getElementById('btn-preview-audience').click();
    await wait(80);
    doc.getElementById('campaign-test-enable').checked = true;
    doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
    await wait(700);
    doc.getElementById('btn-send').click();
    await wait(50);
    assert.equal(alerts.length, 0, alerts.join(' | '));
    assert.equal(doc.getElementById('send-confirm-overlay').hidden, false);
    assert.doesNotMatch(alerts.join(' '), /進階 Flex JSON/);
  } finally { dom.window.close(); }
});

test('Campaign Testing：進階 Flex JSON 可通過確認，不再顯示過時的追蹤警告', async () => {
  const alerts = [];
  const flex = { mode: 'flex_json', flex: { type: 'flex', altText: 'x', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical',
    contents: [{ type: 'button', action: { type: 'uri', label: 'go', uri: 'https://example.com' } }] } } } };
  const { dom, window, doc } = await openWithSequence({
    aConfig: flex,
    fetchOverride: (url) => url === '/admin/broadcast/audience/preview' ? { json: async () => ({ ok: true, total: 20, users: [] }) } : null
  });
  try {
    window.alert = (m) => alerts.push(String(m));
    doc.getElementById('btn-preview-audience').click();
    await wait(80);
    doc.getElementById('campaign-test-enable').checked = true;
    doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
    await wait(700);
    doc.getElementById('btn-send').click();
    await wait(50);
    assert.equal(alerts.length, 0, alerts.join(' | '));
    assert.equal(doc.getElementById('campaign-mode-warning').hidden, true);
    assert.equal(doc.getElementById('send-confirm-overlay').hidden, false);
  } finally { dom.window.close(); }
});

test('單張 Imagemap A/B/C：獨立圖片／連結／測試發送／預覽與草稿，並可進入 Campaign Testing 確認', async () => {
  const a = richConfig('a');
  const b = richConfig('b');
  b.imagemap.assetId = '11111111-2222-4333-8444-555555555555';
  b.imagemap.baseHeight = 1040;
  b.imagemap.areas[0].height = 1040;
  const assets = [
    { id: 42, name: 'A 滿版', mode: 'imagemap', message_config: a },
    { id: 62, name: 'B 滿版', mode: 'imagemap', message_config: b },
    { ...LIB_ITEMS[51], mode: 'flex_json' }
  ];
  const sends = [], alerts = [];
  const override = (url, options) => {
    if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: assets }) };
    const found = assets.find(x => url === '/admin/broadcast/templates/' + x.id);
    if (found) return { json: async () => ({ ok: true, template: found }) };
    if (url === '/admin/broadcast/audience/preview') return { json: async () => ({ ok: true, total: 20, users: [] }) };
    if (url === '/admin/broadcast/test-push') {
      sends.push(JSON.parse(options.body)); return { json: async () => ({ ok: true }) };
    }
    if (url === '/admin/broadcast/preview-message') {
      const cfg = JSON.parse(options.body).message_config;
      const built = buildLineMessages(cfg, { heroImageBaseUrl: 'https://crm.example' });
      return { json: async () => ({ ...built, channel: 'line' }) };
    }
  };
  const page = await openWithSequence({ aConfig: a, fetchOverride: override });
  let restored;
  try {
    const { doc, window } = page;
    window.alert = m => alerts.push(String(m));
    assert.equal(doc.getElementById('message-testing-settings').hidden, false);
    doc.getElementById('campaign-test-enable').checked = true;
    doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
    doc.getElementById('campaign-variant-count').value = '3';
    doc.getElementById('campaign-variant-count').dispatchEvent(new window.Event('change'));
    doc.getElementById('campaign-weight-c').value = '10';
    doc.getElementById('campaign-weight-holdout').value = '70';
    doc.getElementById('campaign-weight-c').dispatchEvent(new window.Event('input'));
    await wait(100);
    const picker = doc.querySelector('#pane-b-sequence [data-seq-swap="0"]');
    assert.equal(doc.getElementById('pane-b-template').hidden, true);
    assert.equal(doc.getElementById('b-lib-row').hidden, true);
    assert.ok([...picker.options].some(o => o.value === '62'));
    assert.ok(![...picker.options].some(o => o.value === '51'), '不得混入 Flex 素材');
    picker.value = '62'; picker.dispatchEvent(new window.Event('change'));
    await wait(650);
    const cLink = [...doc.querySelectorAll('#pane-c-sequence [data-seq-path]')].find(el => el.value.includes('variant=a'));
    cLink.value = 'https://example.com/?variant=c&utm_source=qa';
    cLink.dispatchEvent(new window.Event('input'));
    await wait(650);
    const draft = JSON.parse(window.localStorage.getItem('broadcast_draft_v1'));
    assert.equal(draft.mode, 'imagemap');
    assert.equal(draft.imVariants.b.items[0].message_config.imagemap.assetId, b.imagemap.assetId);
    assert.equal(draft.imVariants.c.items[0].message_config.imagemap.areas[0].uri, cLink.value);
    assert.equal(draft.imagemap.areas[0].uri, a.imagemap.areas[0].uri);
    const images = [...doc.querySelectorAll('#msg-preview img')].map(el => el.getAttribute('src'));
    assert.ok(images.some(src => src.includes(b.imagemap.assetId)));
    assert.ok(images.some(src => src.includes(a.imagemap.assetId)));
    doc.getElementById('test-campaign-variant').value = 'b';
    doc.getElementById('btn-test-push').click(); await wait(40);
    assert.equal(sends[0].message_config.mode, 'imagemap');
    assert.equal(sends[0].message_config.imagemap.assetId, b.imagemap.assetId);
    restored = await openWithSequence({ draft, aConfig: a, fetchOverride: override });
    const savedAgain = JSON.parse(restored.window.localStorage.getItem('broadcast_draft_v1'));
    assert.equal(savedAgain.imVariants.b.items[0].message_config.imagemap.assetId, b.imagemap.assetId);
    assert.equal(restored.doc.getElementById('campaign-test-enable').checked, true);
    // 改 A 圖片、再改回，不覆蓋已編輯的 B/C。
    doc.getElementById('template-select').value = '42';
    doc.getElementById('template-select').dispatchEvent(new window.Event('change'));
    await wait(650);
    assert.match(doc.querySelector('#pane-b-sequence').textContent, /B 滿版/);
    doc.getElementById('btn-preview-audience').click(); await wait(80);
    doc.getElementById('btn-send').click(); await wait(30);
    assert.equal(alerts.length, 0, alerts.join(' | '));
    assert.equal(doc.getElementById('send-confirm-overlay').hidden, false);
    doc.querySelector('#pane-b-sequence [data-seq-reset="b"]').click();
    await wait(600);
    const reset = JSON.parse(window.localStorage.getItem('broadcast_draft_v1'));
    assert.equal(reset.imVariants.b.items[0].message_config.imagemap.assetId, a.imagemap.assetId);
  } finally { page.dom.window.close(); if (restored) restored.dom.window.close(); }
});

for (const mode of ['flex_json', 'imagemap']) {
  test('Campaign Testing 建立 ' + mode + ' A/B/C，保留各版快照與 CTA 歸屬', async () => {
    const configs = Object.fromEntries(['a', 'b', 'c'].map(v => [v, mode === 'imagemap' ? richConfig(v)
      : { mode: 'flex_json', flex: card(v, 'https://example.com/?variant=' + v) }]));
    const result = await create({ channel: 'line', conditions: { allMembers: true },
      message_config: configs.a, variant_b_message_config: configs.b, variant_c_message_config: configs.c,
      campaign_experiment: { enabled: true, variant_count: 3, observation_hours: 24,
        metric: 'ctr', allocations: { a: 10, b: 10, c: 10, holdout: 70 } } });
    assert.equal(result.res.body.ok, true, JSON.stringify(result.res.body));
    assert.deepEqual(result.res.body.variantCounts, { a: 1, b: 1, c: 1, holdout: 1 });
    assert.deepEqual(JSON.parse(result.inserted[0][1]).experiment.variantCMessageConfig, configs.c);
    for (const v of ['a', 'b', 'c']) {
      const built = buildLineMessages(configs[v], { heroImageBaseUrl: 'https://crm.example', broadcastId: 77, recipientId: 11, variant: v });
      const tracked = mode === 'imagemap' ? built.messages[0].actions[0].linkUri : built.messages[0].contents.footer.contents[0].action.uri;
      assert.equal(tracked, 'https://crm.example/r/b/77/11/0?v=' + v);
      assert.match(resolveBroadcastButtonTarget(configs[v], 0, { heroImageBaseUrl: 'https://crm.example' }).uri, new RegExp('variant=' + v));
    }
  });
  for (const v of ['a', 'b', 'c']) {
    test(mode + ' 版本 ' + v + ' 沒有可追蹤 CTA 不得建立實驗', async () => {
      const configs = Object.fromEntries(['a', 'b', 'c'].map(k => [k, mode === 'imagemap' ? richConfig(k)
        : { mode: 'flex_json', flex: card(k, k === v ? null : 'https://example.com/' + k) }]));
      if (mode === 'imagemap') configs[v].imagemap.areas = [{ type: 'message', text: '只傳文字', x: 0, y: 0, width: 1040, height: 780 }];
      const result = await create({ channel: 'line', conditions: { allMembers: true },
        message_config: configs.a, variant_b_message_config: configs.b, variant_c_message_config: configs.c,
        campaign_experiment: { enabled: true, variant_count: 3, observation_hours: 24, metric: 'ctr',
          allocations: { a: 10, b: 10, c: 10, holdout: 70 } } });
      assert.equal(result.res.statusCode, 400);
      assert.equal(result.res.body.error, 'campaign_experiment_requires_cta_button');
      assert.equal(result.inserted.length, 0);
    });
  }
}

test('先開滿版 Campaign Testing 再上傳：A 未完成不凍結空 B；填好 A 後複製完整內容', async () => {
  const blank = richConfig('a'); blank.imagemap.assetId = null; blank.imagemap.areas[0].uri = '';
  const page = await openWithSequence({ aConfig: blank, fetchOverride: url => url === '/admin/broadcast/imagemap/upload'
    ? { json: async () => ({ ok: true, assetId: SHARED_IMAGE, baseWidth: 1040, baseHeight: 780,
      sourceWidth: 1040, sourceHeight: 780, warnings: [] }) } : null });
  try {
    const { doc, window } = page;
    doc.getElementById('campaign-test-enable').checked = true;
    doc.getElementById('campaign-test-enable').dispatchEvent(new window.Event('change'));
    assert.match(doc.getElementById('pane-b-sequence').textContent, /先完成版本 A/);
    const file = new window.File(['x'], 'qa.png', { type: 'image/png' });
    Object.defineProperty(doc.getElementById('im-file'), 'files', { value: [file] });
    doc.getElementById('im-upload').click(); await wait(50);
    assert.match(doc.getElementById('pane-b-sequence').textContent, /先完成版本 A/);
    const uri = doc.querySelector('#im-areas [data-im-field="uri"]');
    uri.value = 'https://example.com/ready'; uri.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(100);
    const saved = JSON.parse(window.localStorage.getItem('broadcast_draft_v1'));
    assert.equal(saved.imVariants.b.items[0].message_config.imagemap.assetId, SHARED_IMAGE);
    assert.equal(saved.imVariants.b.items[0].message_config.imagemap.areas[0].uri, 'https://example.com/ready');
    assert.ok(doc.querySelector('#pane-b-sequence [data-seq-swap]'));
  } finally { page.dom.window.close(); }
});

for (const action of ['reset', 'switch-format']) {
  test('滿版 B 慢速換素材不能蓋過 ' + action, async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const assets = [
      { id: 42, name: 'A', mode: 'imagemap', message_config: richConfig('a') },
      { id: 62, name: 'B', mode: 'imagemap', message_config: richConfig('b') },
      { id: 51, name: '卡片', mode: 'flex_json', message_config: LIB_ITEMS[51].message_config }
    ];
    const page = await openWithSequence({ aConfig: richConfig('a'), fetchOverride: url => {
      if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: assets }) };
      if (url === '/admin/broadcast/templates/62') return pending;
      const found = assets.find(x => url === '/admin/broadcast/templates/' + x.id);
      if (found) return { json: async () => ({ ok: true, template: found }) };
    } });
    try {
      const { doc, window } = page;
      doc.getElementById('ab-test-enable').checked = true;
      doc.getElementById('ab-test-enable').dispatchEvent(new window.Event('change')); await wait(80);
      const picker = doc.querySelector('#pane-b-sequence [data-seq-swap]');
      picker.value = '62'; picker.dispatchEvent(new window.Event('change'));
      if (action === 'reset') doc.querySelector('#pane-b-sequence [data-seq-reset]').click();
      else {
        doc.getElementById('template-select').value = '51';
        doc.getElementById('template-select').dispatchEvent(new window.Event('change')); await wait(150);
      }
      complete({ json: async () => ({ ok: true, template: assets[1] }) }); await wait(650);
      const saved = JSON.parse(window.localStorage.getItem('broadcast_draft_v1'));
      if (action === 'reset') assert.match(saved.imVariants.b.items[0].message_config.imagemap.areas[0].uri, /variant=a/);
      else {
        assert.equal(doc.getElementById('pane-b-sequence').hidden, true);
        assert.equal(doc.getElementById('pane-b-flex-json').hidden, false);
        assert.equal(saved.mode, 'flex_json');
      }
    } finally { page.dom.window.close(); }
  });
}

test('新格式 Campaign Testing 仍必須通過 LINE 預檢，拒絕後零建立', async () => {
  for (const mode of ['imagemap', 'flex_json']) {
    const cfg = mode === 'imagemap' ? richConfig('a') : LIB_ITEMS[51].message_config;
    const result = await create({ channel: 'line', conditions: { allMembers: true }, message_config: cfg,
      variant_b_message_config: cfg, campaign_experiment: { enabled: true, variant_count: 2,
        observation_hours: 24, metric: 'ctr', allocations: { a: 10, b: 10, c: 0, holdout: 80 } } },
      { validate: async () => ({ ok: false, detail: 'invalid LINE payload' }) });
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.inserted.length, 0);
  }
});
