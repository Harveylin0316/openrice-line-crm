'use strict';
// PR #27 審查四項的回歸測試：
// 1. 滿版圖文能存進訊息庫（存檔驗證不需要公開網址）
// 2. 慢速上傳不能蓋掉後來選的新素材
// 3. 上傳上限與 Netlify 函式實際限制一致（4 MB）
// 4. 換成多段訊息後，滿版圖文編輯區要收起
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const media = require('../src/core/imagemapMedia');
const { validateMessageConfig, buildLineMessages } = require('../src/core/broadcastTemplates');

const REPO = path.join(__dirname, '..');
const ORIGIN = 'https://crm.example';
const ASSET_A = '3f2b6a1e-9c4d-4e8f-a1b2-c3d4e5f60718';
const ASSET_B = '7a1c2d3e-4f50-4612-a3b4-c5d6e7f80912';
const ASSET_LIB = '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b';
const wait = ms => new Promise(r => setTimeout(r, ms));

const IMAGEMAP = {
  mode: 'imagemap',
  imagemap: { assetId: ASSET_LIB, baseWidth: 1040, baseHeight: 1040, altText: '訊息庫的滿版圖文', layout: 'full',
    areas: [{ x: 0, y: 0, width: 1040, height: 1040, type: 'uri', uri: 'https://example.com/lib' }] }
};
const SEQUENCE = { mode: 'sequence', items: [{ type: 'text', text: '多段訊息第一段' }, { type: 'text', text: '第二段' }] };

function routesFrom(register, deps) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  register(app, deps);
  return routes;
}
function res() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function run(handlers, req) {
  const out = res();
  for (const h of handlers) {
    let next = false;
    await h(req, out, () => { next = true; });
    if (!next) break;
  }
  return out;
}

// ---------------------------------------------------------------- 1. 存進訊息庫
test('#1 存檔驗證不需要公開網址：滿版圖文通過，內容不完整照樣擋', () => {
  assert.deepEqual(validateMessageConfig(IMAGEMAP), { ok: true });
  // 對照：沒有公開網址時 buildLineMessages 本來就會失敗，以前存檔就是被這個擋住
  assert.equal(buildLineMessages(IMAGEMAP).ok, false);
  const missingAlt = JSON.parse(JSON.stringify(IMAGEMAP)); missingAlt.imagemap.altText = '';
  assert.match(validateMessageConfig(missingAlt).error, /通知預覽文字/);
  const outOfBounds = JSON.parse(JSON.stringify(IMAGEMAP)); outOfBounds.imagemap.areas[0].y = 10;
  assert.match(validateMessageConfig(outOfBounds).error, /超出圖片範圍/);
  // 其他類型照原本規則
  assert.equal(validateMessageConfig(SEQUENCE).ok, true);
  assert.equal(validateMessageConfig({ mode: 'flex_json', flex: null }).ok, false);
});

test('#1 群發「儲存為模板」與訊息庫新增都能存滿版圖文；訊息庫預覽會用公開網址組圖片位置', async () => {
  const inserted = [];
  const q = async (sql, params) => {
    if (/INSERT INTO admin_message_templates/.test(sql)) {
      inserted.push(JSON.parse(params.find(p => typeof p === 'string' && p.startsWith('{"mode"'))));
      return { rows: [{ id: 51, name: 'x', description: null, created_by: 'admin', created_at: new Date() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
  const b = routesFrom(registerAdminBroadcastRoutes, {
    query: q, pool: { connect: async () => ({ query: q, release() {} }) }, authCore: { requireAdmin: (_q, _s, n) => n() },
    linePush: null, emailProvider: null, lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ORIGIN
  });
  const saved = await run(b['POST /admin/broadcast/templates'], { body: { name: '中秋滿版', message_config: IMAGEMAP }, authUser: { un: 'admin' } });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.ok, true);
  assert.equal(inserted[0].mode, 'imagemap');

  const { registerAdminMessagesRoutes } = require('../src/routes/adminMessages');
  const m = routesFrom(registerAdminMessagesRoutes, {
    query: q, authCore: { requireAdmin: (_q, _s, n) => n() }, buildLineMessages, validateMessageConfig,
    resolvePublicSiteOrigin: () => ORIGIN
  });
  const created = await run(m['POST /admin/messages/api'], { body: { name: '中秋滿版 2', channel: 'line', message_config: IMAGEMAP }, authUser: { un: 'admin' } });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const bad = JSON.parse(JSON.stringify(IMAGEMAP)); bad.imagemap.areas = [];
  const rejected = await run(m['POST /admin/messages/api'], { body: { name: 'x', channel: 'line', message_config: bad }, authUser: { un: 'admin' } });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.error, /至少要設定 1 個/);
  const preview = await run(m['POST /admin/messages/api/preview'], { body: { message_config: IMAGEMAP } });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  assert.equal(preview.body.messages[0].baseUrl, ORIGIN + '/p/line-imagemap/' + ASSET_LIB);
});

test('#1 app.js 把存檔驗證與公開網址交給訊息庫路由', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/app.js'), 'utf8');
  const block = src.slice(src.indexOf('registerAdminMessagesRoutes(app, {'), src.indexOf('registerAdminMessagesRoutes(app, {') + 250);
  assert.match(block, /validateMessageConfig/);
  assert.match(block, /resolvePublicSiteOrigin/);
});

// ---------------------------------------------------------------- 3. 4 MB 上限
test('#3 上傳上限與 Netlify 函式一致：伺服器、multer 與前端都是 4 MB', async () => {
  assert.equal(media.MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(media.MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
  const tooBig = Buffer.alloc(media.MAX_UPLOAD_BYTES + 1, 1);
  assert.equal((await media.processImagemapUpload(tooBig, 'image/jpeg')).error, 'file_too_large_max_4mb');
  const route = fs.readFileSync(path.join(REPO, 'src/routes/adminBroadcast.js'), 'utf8');
  assert.match(route, /limits: \{ fileSize: require\('\.\.\/core\/imagemapMedia'\)\.MAX_UPLOAD_BYTES \}/);
  assert.match(route, /'file_too_large_max_4mb'/);
  assert.doesNotMatch(route, /file_too_large_max_10mb/);
  const view = fs.readFileSync(path.join(REPO, 'views/admin_broadcast.ejs'), 'utf8');
  assert.match(view, /4 MB 以內/);
  assert.doesNotMatch(view.slice(view.indexOf('id="pane-imagemap"'), view.indexOf('id="pane-imagemap"') + 800), /10 MB 以內/);
});

// ---------------------------------------------------------------- 後台頁面測試環境
async function openComposer({ uploadResponses = [] } = {}) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const uploads = [];
  const library = { 61: IMAGEMAP, 62: SEQUENCE };
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/imagemap/upload') {
      const next = uploadResponses.shift();
      uploads.push(next);
      return next.promise;
    }
    const m = /^\/admin\/broadcast\/templates\/(\d+)$/.exec(url);
    if (m) return { json: async () => ({ ok: true, template: { id: Number(m[1]), name: '素材 ' + m[1], message_config: library[m[1]] } }) };
    if (url === '/admin/broadcast/preview-message') {
      const built = buildLineMessages(JSON.parse(options.body || '{}').message_config, { heroImageBaseUrl: ORIGIN });
      return { json: async () => (built.ok ? { ok: true, channel: 'line', messages: built.messages } : { ok: false, error: built.error }) };
    }
    return { json: async () => ({ ok: true, recipients: [], templates: [], lists: [] }) };
  };
  window.eval(source);
  await wait(50);
  const doc = window.document;
  const pickLibrary = async (id) => {
    const sel = doc.getElementById('template-select');
    if (!sel.querySelector('option[value="' + id + '"]')) {
      const o = doc.createElement('option'); o.value = String(id); o.textContent = '素材 ' + id; sel.appendChild(o);
    }
    sel.value = String(id);
    sel.dispatchEvent(new window.Event('change'));
    await wait(30);
  };
  const chooseFile = (name) => {
    Object.defineProperty(doc.getElementById('im-file'), 'files', { configurable: true, value: [new window.File(['x'], name, { type: 'image/png' })] });
  };
  return { dom, window, doc, uploads, pickLibrary, chooseFile };
}
function deferredUpload(assetId) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {
    promise,
    finish: () => resolve({ json: async () => ({ ok: true, assetId, baseWidth: 1040, baseHeight: 1040, sourceWidth: 1040, sourceHeight: 1040, warnings: [] }) })
  };
}

// ---------------------------------------------------------------- 2. 慢速上傳
test('#2 慢速上傳回來前，從訊息庫選了另一則滿版圖文：舊上傳不套用', async () => {
  const slow = deferredUpload(ASSET_A);
  const { dom, doc, pickLibrary, chooseFile } = await openComposer({ uploadResponses: [slow] });
  doc.querySelector('[data-msg-style="imagemap"]').click();
  chooseFile('slow.png');
  doc.getElementById('im-upload').click();
  await pickLibrary(61);                                     // 上傳還沒回來就換素材
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET_LIB + '/1040');
  slow.finish();
  await wait(30);
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET_LIB + '/1040', '後來選的素材不能被蓋掉');
  assert.match(doc.getElementById('im-status').textContent, /素材已變更，未套用剛才的上傳/);
  assert.equal(doc.getElementById('msg-alt-text').value, '訊息庫的滿版圖文');
  dom.window.close();
});

test('#2 慢速上傳中換了素材：上傳鈕立刻可用；再上傳的新圖不會被先送出、後回來的舊圖蓋掉', async () => {
  const first = deferredUpload(ASSET_A);
  const second = deferredUpload(ASSET_B);
  const { dom, doc, chooseFile, pickLibrary, uploads } = await openComposer({ uploadResponses: [first, second] });
  doc.querySelector('[data-msg-style="imagemap"]').click();
  chooseFile('a.png'); doc.getElementById('im-upload').click();
  assert.equal(doc.getElementById('im-upload').disabled, true, '上傳中先鎖住，避免重複送');
  await pickLibrary(61);                                     // 換素材 → 舊上傳作廢、按鈕解鎖
  assert.equal(doc.getElementById('im-upload').disabled, false);
  chooseFile('b.png'); doc.getElementById('im-upload').click();
  assert.equal(uploads.length, 2);
  second.finish(); await wait(30);
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET_B + '/1040');
  first.finish(); await wait(30);
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET_B + '/1040');
  assert.equal(doc.getElementById('im-upload').disabled, false);
  dom.window.close();
});

test('#2 上傳期間切回卡片訊息：回來的結果不套用、也不把畫面切回滿版圖文', async () => {
  const slow = deferredUpload(ASSET_A);
  const { dom, doc, chooseFile } = await openComposer({ uploadResponses: [slow] });
  doc.querySelector('[data-msg-style="imagemap"]').click();
  chooseFile('slow.png'); doc.getElementById('im-upload').click();
  doc.querySelector('[data-msg-style="card"]').click();
  slow.finish(); await wait(30);
  assert.equal(doc.getElementById('pane-imagemap').hidden, true);
  assert.equal(doc.getElementById('pane-template').hidden, false);
  assert.equal(doc.getElementById('im-image').hidden, true);
  dom.window.close();
});

test('#2 上傳期間只是改點擊區連結：不算換素材，上傳照常套用', async () => {
  const slow = deferredUpload(ASSET_A);
  const { dom, window, doc, chooseFile } = await openComposer({ uploadResponses: [slow] });
  doc.querySelector('[data-msg-style="imagemap"]').click();
  chooseFile('slow.png'); doc.getElementById('im-upload').click();
  const url = doc.querySelector('#im-areas input[data-im-field="uri"]');
  url.value = 'https://example.com/typed'; url.dispatchEvent(new window.Event('input', { bubbles: true }));
  slow.finish(); await wait(30);
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET_A + '/1040');
  assert.equal(doc.querySelector('#im-areas input[data-im-field="uri"]').value, 'https://example.com/typed');
  dom.window.close();
});

test('#3 前端在送出前就擋下超過 4 MB 的圖片，不會呼叫上傳', async () => {
  const { dom, window, doc, uploads } = await openComposer();
  doc.querySelector('[data-msg-style="imagemap"]').click();
  const big = new window.File(['x'], 'big.png', { type: 'image/png' });
  Object.defineProperty(big, 'size', { value: 4 * 1024 * 1024 + 1 });
  Object.defineProperty(doc.getElementById('im-file'), 'files', { value: [big] });
  doc.getElementById('im-upload').click();
  await wait(20);
  assert.equal(uploads.length, 0);
  assert.match(doc.getElementById('im-status').textContent, /超過 4 MB/);
  dom.window.close();
});

// ---------------------------------------------------------------- 4. 換成多段訊息
test('#4 正在編輯滿版圖文時從訊息庫選多段訊息：滿版圖文編輯區收起、顯示多段訊息', async () => {
  const { dom, doc, pickLibrary } = await openComposer();
  doc.querySelector('[data-msg-style="imagemap"]').click();
  assert.equal(doc.getElementById('pane-imagemap').hidden, false);
  await pickLibrary(62);
  assert.equal(doc.getElementById('pane-imagemap').hidden, true, '舊的滿版圖文編輯區要收起');
  assert.equal(doc.getElementById('pane-sequence').hidden, false);
  assert.equal(doc.getElementById('msg-style-chooser').hidden, true);
  assert.equal(doc.querySelector('[data-msg-style="card"]').classList.contains('active'), true);
  assert.equal(doc.querySelector('[data-msg-style="imagemap"]').classList.contains('active'), false);
  dom.window.close();
});

test('#4 從滿版圖文換成一般卡片素材：編輯區收起、進階區與 A/B 設定放回來', async () => {
  const { dom, doc, pickLibrary } = await openComposer();
  doc.querySelector('[data-msg-style="imagemap"]').click();
  await pickLibrary(61);                                     // 先載入滿版圖文
  assert.equal(doc.getElementById('pane-imagemap').hidden, false);
  assert.equal(doc.getElementById('message-testing-settings').hidden, true);
  // 換成多段 → 再換回滿版 → 切卡片：每一步都不殘留
  await pickLibrary(62);
  assert.equal(doc.getElementById('pane-imagemap').hidden, true);
  assert.equal(doc.getElementById('message-testing-settings').hidden, false);
  await pickLibrary(61);
  assert.equal(doc.getElementById('pane-imagemap').hidden, false);
  assert.equal(doc.getElementById('pane-sequence').hidden, true);
  dom.window.close();
});
