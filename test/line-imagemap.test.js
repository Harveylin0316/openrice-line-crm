'use strict';
// 滿版圖文訊息（LINE 原生 imagemap）：上傳一次 → 五種寬度 → baseUrl/<寬度>；
// payload 是原生 imagemap（不是 Flex 模擬）；點擊區有各自的追蹤序號；後台編輯器與預覽。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { Jimp } = require('jimp');

const media = require('../src/core/imagemapMedia');
const { buildLineMessages, resolveBroadcastButtonTarget, listBroadcastButtons } = require('../src/core/broadcastTemplates');
const { getBroadcastMessageIdentity } = require('../src/core/broadcastMessageSnapshot');

const REPO = path.join(__dirname, '..');
const ORIGIN = 'https://crm.example';
const ASSET = '3f2b6a1e-9c4d-4e8f-a1b2-c3d4e5f60718';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function solid(w, h, mime) {
  return new Jimp({ width: w, height: h, color: 0x336699ff }).getBuffer(mime);
}
function imCfg(areas, extra) {
  return { mode: 'imagemap', imagemap: Object.assign({ assetId: ASSET, baseWidth: 1040, baseHeight: 1040, altText: '中秋活動', layout: 'custom', areas }, extra || {}) };
}

// ---------------------------------------------------------------- 圖片處理
test('上傳 1040×1040：產生 1040/700/460/300/240 五種寬度，1040 版是原檔不重壓', async () => {
  const buf = await solid(1040, 1040, 'image/jpeg');
  const r = await media.processImagemapUpload(buf, 'image/jpeg');
  assert.equal(r.ok, true);
  assert.equal(r.baseHeight, 1040);
  assert.deepEqual(r.files.map(f => [f.width, f.height]), [[1040, 1040], [700, 700], [460, 460], [300, 300], [240, 240]]);
  assert.equal(r.files[0].buffer, buf, '剛好 1040 寬就用原檔');
  assert.deepEqual(r.warnings, []);
  for (const f of r.files.slice(1)) {
    const back = await Jimp.read(f.buffer);
    assert.equal(back.bitmap.width, f.width);
    assert.equal(back.bitmap.height, f.height);
  }
});

test('任何比例：不裁切、不警告，依原比例算 baseHeight；PNG 維持 PNG', async () => {
  const r = await media.processImagemapUpload(await solid(1040, 780, 'image/png'), 'image/png');
  assert.equal(r.ok, true);
  assert.equal(r.baseHeight, 780);
  assert.deepEqual(r.files.map(f => [f.width, f.height]), [[1040, 780], [700, 525], [460, 345], [300, 225], [240, 180]]);
  assert.ok(r.files.every(f => f.mime === 'image/png'));
  assert.deepEqual(r.warnings, [], '比例不限，不再提示不是 1:1');
});

test('大於或小於 1040 的方圖：等比例縮放到 1040 寬並提示；過長、格式不對直接擋', async () => {
  const big = await media.processImagemapUpload(await solid(2080, 2080, 'image/jpeg'), 'image/jpeg');
  assert.equal(big.ok, true);
  assert.equal(big.files[0].width, 1040);
  assert.match(big.warnings.join(''), /縮放成 1040px/);
  const small = await media.processImagemapUpload(await solid(800, 800, 'image/jpeg'), 'image/jpeg');
  assert.match(small.warnings.join(''), /可能會模糊/);
  // 直式長圖可以（1040×2400，以前會被擋）；超過 1:6 才擋
  const tall = await media.processImagemapUpload(await solid(1040, 2400, 'image/jpeg'), 'image/jpeg');
  assert.equal(tall.ok, true);
  assert.equal(tall.baseHeight, 2400);
  assert.deepEqual(tall.files.map(f => [f.width, f.height]).slice(0, 2), [[1040, 2400], [700, 1615]]);
  const wide = await media.processImagemapUpload(await solid(2080, 400, 'image/jpeg'), 'image/jpeg');
  assert.equal(wide.ok, true, '橫式長條也可以');
  assert.equal(wide.baseHeight, 200);
  assert.equal((await media.processImagemapUpload(await solid(600, 4000, 'image/jpeg'), 'image/jpeg')).error, 'image_too_tall');
  assert.equal((await media.processImagemapUpload(Buffer.from('GIF89a'), 'image/gif')).error, 'only_png_or_jpeg');
  assert.equal((await media.processImagemapUpload(Buffer.from('not an image'), 'image/png')).error, 'image_unreadable');
});

test('每種寬度的存放 id 由 assetId 固定推導，存進既有的 line_push_media（不需新資料表）', async () => {
  const ids = media.IMAGEMAP_WIDTHS.map(w => media.deriveMediaId(ASSET, w));
  assert.equal(new Set(ids).size, 5);
  ids.forEach(id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  assert.equal(media.deriveMediaId(ASSET.toUpperCase(), 700), media.deriveMediaId(ASSET, 700));
  const sqls = [];
  await media.storeImagemapFiles(async (sql, params) => { sqls.push({ sql, params }); return { rows: [] }; },
    ASSET, media.IMAGEMAP_WIDTHS.map(w => ({ width: w, mime: 'image/jpeg', buffer: Buffer.from('x') })));
  assert.equal(sqls.length, 5);
  assert.ok(sqls.every(q => /INSERT INTO line_push_media/.test(q.sql)));
  assert.deepEqual(sqls.map(q => q.params[0]), ids);
});

// ---------------------------------------------------------------- 路由
function routesFrom(register, deps) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete', 'use'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  register(app, deps);
  return routes;
}
function res() {
  return {
    statusCode: 200, headers: {},
    status(c) { this.statusCode = c; return this; }, type(t) { this.headers['content-type'] = t; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; }
  };
}

test('GET /p/line-imagemap/<assetId>/<寬度>：沒有副檔名、只接受 LINE 規定的五種寬度、長快取', async () => {
  const { registerWebRoutes } = require('../src/routes/web');
  const stored = {};
  stored[media.deriveMediaId(ASSET, 460)] = { mime_type: 'image/jpeg', body: Buffer.from('JPEG460') };
  const routes = routesFrom(registerWebRoutes, {
    query: async (sql, params) => (/FROM line_push_media/.test(sql) && stored[params[0]] ? { rowCount: 1, rows: [stored[params[0]]] } : { rowCount: 0, rows: [] }),
    pool: {}, authCore: { requireAdmin: (_q, _s, n) => n() }, lotteryCore: {}, viewStateCore: {}
  });
  const key = 'GET /p/line-imagemap/:assetId/:width(1040|700|460|300|240)';
  assert.ok(routes[key], '要有 imagemap 圖片路由');
  const ok = res();
  await routes[key][0]({ params: { assetId: ASSET, width: '460' } }, ok, e => { throw e; });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.match(ok.headers['cache-control'], /immutable/);
  assert.equal(String(ok.body), 'JPEG460');
  const miss = res();
  await routes[key][0]({ params: { assetId: ASSET, width: '700' } }, miss, e => { throw e; });
  assert.equal(miss.statusCode, 404);
  const bad = res();
  await routes[key][0]({ params: { assetId: 'nope', width: '460' } }, bad, e => { throw e; });
  assert.equal(bad.statusCode, 404);
});

test('POST /admin/broadcast/imagemap/upload：處理並存五種尺寸、回傳 baseUrl 與警告', async () => {
  const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
  const inserted = [];
  const routes = routesFrom(registerAdminBroadcastRoutes, {
    query: async (sql, params) => { if (/INSERT INTO line_push_media/.test(sql)) inserted.push(params); return { rows: [], rowCount: 1 }; },
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) },
    authCore: { requireAdmin: (_q, _s, n) => n() },
    linePush: null, emailProvider: null, lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ORIGIN
  });
  const handlers = routes['POST /admin/broadcast/imagemap/upload'];
  assert.ok(handlers);
  const final = handlers[handlers.length - 1];
  const out = res();
  await final({ file: { buffer: await solid(1040, 1040, 'image/png'), mimetype: 'image/png' }, get: () => 'crm.example' }, out);
  assert.equal(out.body.ok, true, JSON.stringify(out.body));
  assert.equal(out.body.baseHeight, 1040);
  assert.equal(out.body.baseUrl, ORIGIN + '/p/line-imagemap/' + out.body.assetId);
  assert.deepEqual(out.body.sizes.map(s => s.width), [1040, 700, 460, 300, 240]);
  assert.equal(inserted.length, 5);
  const bad = res();
  await final({ file: { buffer: Buffer.from('x'), mimetype: 'image/png' }, get: () => '' }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'image_unreadable');
});

// ---------------------------------------------------------------- 訊息 payload
test('整張一個連結：產生原生 imagemap，baseUrl 無副檔名、baseSize 1040×1040、一個全圖區域', () => {
  const b = buildLineMessages(imCfg([{ x: 0, y: 0, width: 1040, height: 1040, type: 'uri', uri: 'https://example.com' }]), { heroImageBaseUrl: ORIGIN });
  assert.equal(b.ok, true, b.error);
  assert.deepEqual(b.messages, [{
    type: 'imagemap',
    baseUrl: ORIGIN + '/p/line-imagemap/' + ASSET,
    altText: '中秋活動',
    baseSize: { width: 1040, height: 1040 },
    actions: [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 1040, height: 1040 } }]
  }]);
});

test('上下兩區：兩個不同 URL，座標與需求文件一致；左右兩區同理', () => {
  const tb = buildLineMessages(imCfg([
    { x: 0, y: 0, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/a' },
    { x: 0, y: 520, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/b' }
  ]), { heroImageBaseUrl: ORIGIN });
  assert.deepEqual(tb.messages[0].actions, [
    { type: 'uri', linkUri: 'https://example.com/a', area: { x: 0, y: 0, width: 1040, height: 520 } },
    { type: 'uri', linkUri: 'https://example.com/b', area: { x: 0, y: 520, width: 1040, height: 520 } }
  ]);
  const lr = buildLineMessages(imCfg([
    { x: 0, y: 0, width: 520, height: 1040, type: 'uri', uri: 'https://example.com/l', label: '左邊' },
    { x: 520, y: 0, width: 520, height: 1040, type: 'message', text: '我要報名' }
  ]), { heroImageBaseUrl: ORIGIN });
  assert.deepEqual(lr.messages[0].actions, [
    { type: 'uri', linkUri: 'https://example.com/l', area: { x: 0, y: 0, width: 520, height: 1040 }, label: '左邊' },
    { type: 'message', text: '我要報名', area: { x: 520, y: 0, width: 520, height: 1040 } }
  ]);
});

test('驗證：缺圖、缺通知文字、超出範圍、無效網址、超過 50 區、沒有 https 公開網址都擋下', () => {
  const area = { x: 0, y: 0, width: 1040, height: 1040, type: 'uri', uri: 'https://example.com' };
  const err = (cfg, opts) => buildLineMessages(cfg, Object.assign({ heroImageBaseUrl: ORIGIN }, opts)).error;
  assert.match(err(imCfg([area], { assetId: '' })), /請先上傳圖片/);
  assert.match(err(imCfg([area], { altText: '' })), /通知預覽文字/);
  assert.match(err(imCfg([Object.assign({}, area, { y: 10 })])), /超出圖片範圍/);
  assert.match(err(imCfg([Object.assign({}, area, { uri: 'javascript:alert(1)' })])), /連結要是/);
  assert.match(err(imCfg(Array.from({ length: 51 }, () => area))), /最多 50/);
  assert.match(err(imCfg([])), /至少要設定 1 個/);
  assert.match(err(imCfg([area]), { heroImageBaseUrl: 'http://localhost:3000' }), /https/);
  assert.equal(buildLineMessages(imCfg([Object.assign({}, area, { uri: 'tel:0223456789' })]), { heroImageBaseUrl: ORIGIN }).ok, true);
});

test('群發追蹤：每個開啟網址的區域包成 /r/b/<批次>/<收件人>/<序號>，點擊可反查回原網址；個人化通知文字', () => {
  const cfg = imCfg([
    { x: 0, y: 0, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/a' },
    { x: 0, y: 520, width: 520, height: 520, type: 'message', text: 'hi' },
    { x: 520, y: 520, width: 520, height: 520, type: 'uri', uri: 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles' }
  ], { altText: '{暱稱}，中秋活動' });
  const b = buildLineMessages(cfg, { heroImageBaseUrl: ORIGIN, broadcastId: 12, recipientId: 7, recipientName: 'Ice' });
  const acts = b.messages[0].actions;
  assert.equal(b.messages[0].altText, 'Ice，中秋活動');
  assert.equal(acts[0].linkUri, ORIGIN + '/r/b/12/7/0');
  assert.equal(acts[1].type, 'message');
  assert.equal(acts[2].linkUri, ORIGIN + '/r/b/12/7/1');
  assert.equal(resolveBroadcastButtonTarget(cfg, 1, { heroImageBaseUrl: ORIGIN }).uri, 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles');
  assert.deepEqual(listBroadcastButtons(cfg, { heroImageBaseUrl: ORIGIN }).map(x => x.uri), ['https://example.com/a', 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles']);
  // 預覽／測試發送沒有批次：不包追蹤
  const plain = buildLineMessages(cfg, { heroImageBaseUrl: ORIGIN });
  assert.equal(plain.messages[0].actions[0].linkUri, 'https://example.com/a');
});

test('多段訊息與 Flex 不受影響；發送紀錄把它辨識為「滿版圖文訊息」', () => {
  const flex = { mode: 'flex_json', flex: { type: 'flex', altText: 'x', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label: 'go', uri: 'https://example.com/f' } }] } } } };
  const fb = buildLineMessages(flex, { heroImageBaseUrl: ORIGIN, broadcastId: 1, recipientId: 2 });
  assert.equal(fb.messages[0].type, 'flex');
  assert.equal(fb.messages[0].contents.body.contents[0].action.uri, ORIGIN + '/r/b/1/2/0');
  const id = getBroadcastMessageIdentity({ channel: 'line', message_config: imCfg([{ x: 0, y: 0, width: 1040, height: 1040, type: 'uri', uri: 'https://example.com' }]) });
  assert.equal(id.notificationText, '中秋活動');
});

// ---------------------------------------------------------------- 後台編輯器
async function openComposer() {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const previews = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 260, height: 260, right: 260, bottom: 260 }; };
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/imagemap/upload') {
      return { json: async () => ({ ok: true, assetId: ASSET, baseWidth: 1040, baseHeight: 1040, sourceWidth: 1040, sourceHeight: 1040, warnings: [], baseUrl: ORIGIN + '/p/line-imagemap/' + ASSET }) };
    }
    if (url === '/admin/broadcast/preview-message') {
      const cfg = JSON.parse(options.body || '{}').message_config;
      previews.push(cfg);
      const built = buildLineMessages(cfg, { heroImageBaseUrl: ORIGIN });
      return { json: async () => (built.ok ? { ok: true, channel: 'line', messages: built.messages } : { ok: false, error: built.error }) };
    }
    return { json: async () => ({ ok: true, recipients: [], templates: [], lists: [] }) };
  };
  window.eval(source);
  await wait(60);
  return { dom, window, doc: window.document, previews };
}

test('選「滿版圖文訊息」：顯示專屬編輯區與 A/B、隱藏卡片欄位；上傳後選上下兩區、填網址，預覽送出原生 imagemap', async () => {
  const { dom, window, doc, previews } = await openComposer();
  doc.querySelector('[data-msg-style="imagemap"]').click();
  assert.equal(doc.getElementById('pane-imagemap').hidden, false);
  assert.equal(doc.getElementById('pane-template').hidden, true);
  assert.equal(doc.getElementById('advanced-json-block').hidden, true);
  assert.equal(doc.getElementById('message-testing-settings').hidden, false, '單張滿版圖文也可設定 A/B');

  const file = new window.File(['x'], 'rich.png', { type: 'image/png' });
  Object.defineProperty(doc.getElementById('im-file'), 'files', { value: [file] });
  doc.getElementById('im-upload').click();
  await wait(30);
  assert.match(doc.getElementById('im-status').textContent, /已上傳/);
  assert.equal(doc.getElementById('im-image').getAttribute('src'), '/p/line-imagemap/' + ASSET + '/1040');

  doc.querySelector('[data-im-layout="top_bottom"]').click();
  const urls = doc.querySelectorAll('#im-areas input[data-im-field="uri"]');
  assert.equal(urls.length, 2);
  urls[0].value = 'https://example.com/a'; urls[0].dispatchEvent(new window.Event('input', { bubbles: true }));
  urls[1].value = 'https://example.com/b'; urls[1].dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('msg-alt-text').value = '中秋活動';
  doc.getElementById('msg-alt-text').dispatchEvent(new window.Event('input', { bubbles: true }));
  // 預設版型的座標唯讀（避免誤改）
  assert.equal(doc.querySelector('#im-areas input[data-im-field="x"]').readOnly, true);
  await wait(700);

  const last = previews.filter(p => p && p.mode === 'imagemap').pop();
  assert.ok(last, '預覽要送出 imagemap 設定');
  assert.equal(last.imagemap.assetId, ASSET);
  assert.equal(last.imagemap.layout, 'top_bottom');
  assert.deepEqual(last.imagemap.areas, [
    { x: 0, y: 0, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/a' },
    { x: 0, y: 520, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/b' }
  ]);
  // 預覽：與 Flex 分開、不套 bubble 外框、1:1、每區可點
  const preview = doc.querySelector('.line-mock.is-imagemap');
  assert.ok(preview, '預覽框要切成 imagemap 模式');
  assert.match(preview.textContent, /Rich Message（LINE imagemap）預覽/);
  const anchors = preview.querySelectorAll('a[data-im-mock-area]');
  assert.deepEqual([...anchors].map(a => a.getAttribute('href')), ['https://example.com/a', 'https://example.com/b']);
  assert.equal(anchors[1].style.top, '50%');
  assert.equal(preview.querySelector('.im-mock').style.aspectRatio, '1040 / 1040');
  dom.window.close();
});

test('自訂版型：在圖上拖拉新增區域、拖拉既有區域移動；切回卡片訊息恢復原本編輯區', async () => {
  const { dom, window, doc } = await openComposer();
  doc.querySelector('[data-msg-style="imagemap"]').click();
  Object.defineProperty(doc.getElementById('im-file'), 'files', { value: [new window.File(['x'], 'a.png', { type: 'image/png' })] });
  doc.getElementById('im-upload').click();
  await wait(30);
  doc.querySelector('[data-im-layout="custom"]').click();
  assert.equal(doc.getElementById('im-custom-hint').hidden, false);
  const canvas = doc.getElementById('im-canvas');
  const ev = (type, x, y, target) => {
    const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    (target || canvas).dispatchEvent(e);
  };
  // 真實瀏覽器裡，按下去的點落在預設的全圖區域上：一樣要能畫出新區域
  ev('pointerdown', 26, 26, doc.querySelector('[data-im-area="0"]'));
  ev('pointermove', 130, 104);
  ev('pointerup', 130, 104);
  // 預設的全圖區域＋剛畫的那一區：x=104 y=104 寬 416 高 312（畫布 260px 對應 1040）
  const rows = doc.querySelectorAll('#im-areas .im-area-row');
  assert.equal(rows.length, 2);
  const val = (i, f) => Number(doc.querySelector('#im-areas input[data-im-field="' + f + '"][data-i="' + i + '"]').value);
  assert.deepEqual([val(1, 'x'), val(1, 'y'), val(1, 'width'), val(1, 'height')], [104, 104, 416, 312]);
  assert.equal(doc.querySelectorAll('#im-overlay .im-area').length, 2);
  // 太小的拖拉（誤觸）不新增
  ev('pointerdown', 200, 200, doc.querySelector('[data-im-area="0"]'));
  ev('pointermove', 202, 202);
  ev('pointerup', 202, 202);
  assert.equal(doc.querySelectorAll('#im-areas .im-area-row').length, 2);
  // 沒拖動的點一下＝選取那一區
  assert.equal(doc.querySelector('[data-im-area="0"]').classList.contains('selected'), true);
  // 拖拉編號＝移動：第 2 區往右下 26px（=104）
  ev('pointerdown', 30, 30, doc.querySelector('[data-im-area="1"] b'));
  ev('pointermove', 56, 56);
  ev('pointerup', 56, 56);
  assert.deepEqual([val(1, 'x'), val(1, 'y'), val(1, 'width'), val(1, 'height')], [208, 208, 416, 312]);
  // 預設全圖區域被點到 → 選取並移動：從 (130,130) 拖到 (130,130) 不會超出
  const num = (i, f) => Number(doc.querySelector('#im-areas input[data-im-field="' + f + '"][data-i="' + i + '"]').value);
  const before = num(0, 'x');
  ev('pointerdown', 4, 4, doc.querySelector('[data-im-area="0"] b'));
  ev('pointermove', 30, 30);
  ev('pointerup', 30, 30);
  assert.equal(num(0, 'x'), before, '全圖區域已貼齊邊界，移動會被夾回範圍內');
  // 自訂模式座標可直接改
  const w = doc.querySelector('#im-areas input[data-im-field="width"][data-i="0"]');
  assert.equal(w.readOnly, false);
  w.value = '500'; w.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('[data-im-area="0"]').style.width, (500 / 1040 * 100) + '%');
  // 新增區域按鈕
  const count = doc.querySelectorAll('#im-areas .im-area-row').length;
  doc.getElementById('im-add-area').click();
  assert.equal(doc.querySelectorAll('#im-areas .im-area-row').length, count + 1);
  // 切回卡片
  doc.querySelector('[data-msg-style="card"]').click();
  assert.equal(doc.getElementById('pane-imagemap').hidden, true);
  assert.equal(doc.getElementById('pane-template').hidden, false);
  assert.equal(doc.getElementById('message-testing-settings').hidden, false);
  dom.window.close();
});

test('訊息庫卡片可預覽滿版圖文訊息（維持比例並標出點擊區）', () => {
  const src = fs.readFileSync(path.join(REPO, 'views', 'admin_messages.ejs'), 'utf8');
  const start = src.indexOf('function renderPreview(stage,cfg){');
  assert.ok(start > 0);
  assert.match(src.slice(start, start + 2500), /cfg\.mode==='imagemap'/);
  assert.match(src.slice(start, start + 2500), /\/p\/line-imagemap\/'\+imc\.assetId\+'\/1040/);
});

test('任何比例：直式 1040×2400 可以組成 imagemap、點擊區可放在下半部；超過 1:6 擋下', () => {
  const tall = imCfg([{ x: 0, y: 1800, width: 1040, height: 600, type: 'uri', uri: 'https://example.com/bottom' }], { baseHeight: 2400 });
  const b = buildLineMessages(tall, { heroImageBaseUrl: ORIGIN });
  assert.equal(b.ok, true, b.error);
  assert.deepEqual(b.messages[0].baseSize, { width: 1040, height: 2400 });
  assert.deepEqual(b.messages[0].actions[0].area, { x: 0, y: 1800, width: 1040, height: 600 });
  const wide = imCfg([{ x: 0, y: 0, width: 1040, height: 200, type: 'uri', uri: 'https://example.com/w' }], { baseHeight: 200 });
  assert.equal(buildLineMessages(wide, { heroImageBaseUrl: ORIGIN }).ok, true, '橫式長條');
  const tooTall = imCfg([{ x: 0, y: 0, width: 1040, height: 100, type: 'uri', uri: 'https://example.com/x' }], { baseHeight: 7000 });
  assert.match(buildLineMessages(tooTall, { heroImageBaseUrl: ORIGIN }).error, /高度資訊不正確/);
});
