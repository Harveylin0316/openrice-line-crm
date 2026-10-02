'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { buildLineMessages, validateMessageConfig } = require('../src/core/broadcastTemplates');
const { registerAdminMessagesRoutes } = require('../src/routes/adminMessages');
const clone = x => JSON.parse(JSON.stringify(x));
const wait = () => new Promise(r => setImmediate(r));
const origin = 'https://crm.example';
const imagemap = { mode: 'imagemap', imagemap: {
  assetId: '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b', baseHeight: 780, altText: 'SYNTHETIC snapshot',
  areas: [{ type: 'uri', uri: 'https://example.com/offer', x: 0, y: 0, width: 1040, height: 780 }]
}};
const sequence = { mode: 'sequence', items: [
  { type: 'text', text: 'SYNTHETIC intro' }, { type: 'card', source_message_id: 7, message_config: imagemap }
] };
const injectedId = '7"></option></select><img id="injected-marker" onerror="window.syntheticMarker=1"><select><option value="7';

test('素材編號：正整數、數字字串及無來源快照仍能存檔與組裝', () => {
  for (const key of ['source_message_id', 'message_id']) {
    for (const id of [undefined, null, '', 7, '7', '007', Number.MAX_SAFE_INTEGER]) {
      const cfg = clone(sequence); delete cfg.items[1].source_message_id;
      if (id !== undefined) cfg.items[1][key] = id;
      assert.equal(validateMessageConfig(cfg).ok, true);
      const built = buildLineMessages(cfg, { heroImageBaseUrl: origin });
      assert.equal(built.ok, true);
      assert.deepEqual(built.messages.map(m => m.type), ['text', 'imagemap']);
    }
  }
});

test('素材編號：新舊欄位的 HTML／物件／布林／小數／不安全整數均拒絕', () => {
  for (const key of ['source_message_id', 'message_id']) {
    for (const id of [injectedId, '7" onmouseover="x', {}, [7], true, false, 0, -1, 1.5, '1e2', '0x7', ' 7 ', Number.MAX_SAFE_INTEGER + 1]) {
      const cfg = clone(sequence); cfg.items[1][key] = id;
      for (const result of [validateMessageConfig(cfg), buildLineMessages(cfg, { heroImageBaseUrl: origin })]) {
        assert.equal(result.ok, false, key + ' ' + JSON.stringify(id));
        assert.match(result.error, /第 2 個內容：素材編號格式不正確/);
      }
    }
  }
});

test('訊息庫新增與修改：異常來源編號在資料库寫入前回 400', async () => {
  const handlers = {}; let writes = 0;
  const app = {}; ['get', 'post', 'put', 'delete'].forEach(m => { app[m] = (p, ...h) => { handlers[m + ' ' + p] = h; }; });
  registerAdminMessagesRoutes(app, {
    query: async () => { writes++; return { rowCount: 1, rows: [{ id: 8 }] }; },
    authCore: { requireAdmin: (_q, _s, n) => n() }, buildLineMessages, validateMessageConfig
  });
  for (const route of ['post /admin/messages/api', 'put /admin/messages/api/:id']) {
    for (const key of ['source_message_id', 'message_id']) {
      const cfg = clone(sequence); cfg.items[1][key] = injectedId;
      const req = { body: { name: 'SYNTHETIC', message_config: cfg }, params: { id: '8' } };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      for (const h of handlers[route]) { let next = false; await h(req, res, () => { next = true; }); if (!next) break; }
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /素材編號格式不正確/);
    }
  }
  assert.equal(writes, 0);
});

async function editor(cfg, library = []) {
  const html = ejs.render(fs.readFileSync(path.join(__dirname, '../views/admin_message_sequence.ejs'), 'utf8'), {
    user: 'SYNTHETIC', isAdmin: true, bodyClass: '', include: (_n, o) => o.body
  });
  const sent = [];
  const dom = new JSDOM(html, { url: origin + '/admin/messages/sequence?mid=8', runScripts: 'dangerously', beforeParse(w) {
    w.fetch = async (url, opts) => {
      if (opts) { sent.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ ok: false, error: 'synthetic capture only' }) }; }
      return { json: async () => url.includes('test-recipients') ? { ok: true, recipients: [{ label: 'SYNTHETIC', line_user_id: 'U' + '0'.repeat(32) }] }
        : url.endsWith('/list') ? { messages: library }
          : { ok: true, message: { name: 'SYNTHETIC', message_config: cfg } } };
    };
  }});
  try {
    for (let i = 0; i < 100 && !dom.window.document.querySelector('[data-card]'); i++) await wait();
    assert.ok(dom.window.document.querySelector('[data-card]'), 'editor finished loading');
    return { dom, doc: dom.window.document, sent };
  } catch (e) { dom.window.close(); throw e; }
}

test('歷史異常 ID 安全顯示：兩種來源欄位不能產生元素／執行事件', async () => {
  for (const key of ['source_message_id', 'message_id']) {
    const cfg = clone(sequence); delete cfg.items[1].source_message_id; cfg.items[1][key] = injectedId;
    const { dom, doc } = await editor(cfg);
    try {
      assert.equal(doc.querySelector('#injected-marker'), null);
      assert.equal(dom.window.syntheticMarker, undefined);
      assert.equal(doc.querySelector('[data-card]').value, injectedId);
      assert.match(doc.querySelector('[data-card]').selectedOptions[0].textContent, /已儲存版本/);
      doc.querySelector('[data-up="1"]').click();
      assert.equal(doc.querySelector('#injected-marker'), null);
      assert.equal(dom.window.syntheticMarker, undefined);
    } finally { dom.window.close(); }
  }
});

test('素材清單的異常 ID／名稱同樣安全顯示', async () => {
  const cfg = clone(sequence); cfg.items[1].source_message_id = injectedId;
  const { dom, doc } = await editor(cfg, [{ id: injectedId, name: '<img id="name-marker" onerror="window.syntheticMarker=2">', message_config: imagemap }]);
  try {
    assert.equal(doc.querySelector('#injected-marker'), null);
    assert.equal(doc.querySelector('#name-marker'), null);
    assert.equal(dom.window.syntheticMarker, undefined);
    assert.equal(doc.querySelector('[data-card]').value, injectedId);
  } finally { dom.window.close(); }
});

test('已刪素材與 legacy ID：排序、存檔、測試發送維持合法快照', async () => {
  for (const key of ['source_message_id', 'message_id']) {
    const cfg = clone(sequence); delete cfg.items[1].source_message_id; cfg.items[1][key] = 7;
    const { dom, doc, sent } = await editor(cfg);
    try {
      assert.equal(doc.querySelector('[data-card]').value, '7');
      assert.match(doc.querySelector('[data-card]').textContent, /原素材目前無法取得/);
      assert.equal(doc.querySelectorAll('.msq-imagemap-area').length, 1);
      doc.querySelector('[data-up="1"]').click();
      doc.querySelector('#msq-save').click();
      doc.querySelector('#msq-test').click();
      assert.equal(sent.length, 2);
      for (const s of sent) {
        assert.deepEqual(s.body.message_config.items[0].message_config, imagemap);
        const result = buildLineMessages(s.body.message_config, { heroImageBaseUrl: origin });
        assert.deepEqual(result.messages.map(m => m.type), ['imagemap', 'text']);
      }
      await wait();
    } finally { dom.window.close(); }
  }
});
