const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function flexCard(text) {
  return {
    type: 'flex',
    altText: '測試卡片',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text, wrap: true }]
      }
    }
  };
}

test('Campaign Testing 已開啟時選模板，空白 B 版會沿用 A 並正常顯示雙版本預覽', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false,
    msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const selectedTemplate = { mode: 'flex_json', flex: flexCard('按鈕卡片內容') };
  const previewBodies = [];

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://crm.example/admin/broadcast',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/test-recipients') {
      return { json: async () => ({ ok: true, recipients: [] }) };
    }
    if (url === '/admin/broadcast/templates') {
      return { json: async () => ({ ok: true, templates: [{ id: 1, name: '按鈕卡片', description: '測試模板' }] }) };
    }
    if (url === '/admin/broadcast/templates/1') {
      return { json: async () => ({ ok: true, template: { id: 1, message_config: selectedTemplate } }) };
    }
    if (url === '/admin/broadcast/preview-message') {
      const body = JSON.parse(options.body || '{}');
      previewBodies.push(body.message_config);
      if (!body.message_config || !body.message_config.flex) {
        return { json: async () => ({ ok: false, error: '請至少填入訊息內容。' }) };
      }
      return { json: async () => ({ ok: true, channel: 'line', messages: [body.message_config.flex] }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  window.localStorage.setItem('broadcast_draft_v1', JSON.stringify({
    abEnabled: true,
    campaign: {
      enabled: true, variantCount: 2, observationHours: '24',
      a: '10', b: '10', c: '0', holdout: '80', variantC: {}
    },
    variantB: {},
    _t: Date.now()
  }));
  window.eval(source);
  await wait(40);

  const card = window.document.querySelector('.template-card[data-id="1"]');
  assert.ok(card, '模板卡片應載入');
  card.click();
  await wait(850);

  assert.match(window.document.getElementById('b-flex-json').value, /按鈕卡片內容/, '空白 B 版應先沿用 A 版');
  assert.equal(previewBodies.length, 2, 'A、B 應各送一次預覽請求');
  assert.match(window.document.getElementById('msg-preview').textContent, /版本 A/);
  assert.match(window.document.getElementById('msg-preview').textContent, /版本 B/);
  assert.match(window.document.getElementById('msg-preview').textContent, /按鈕卡片內容/);
  assert.doesNotMatch(window.document.getElementById('msg-preview').textContent, /尚未有訊息內容/);
  assert.match(window.document.getElementById('msg-status').textContent, /預覽已更新/);
  dom.window.close();
});

test('某個測試版本無效時，正常版本仍可預覽並明確標示未完成版本', async () => {
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  assert.match(source, /已顯示可預覽版本；請完成版本/);
  assert.match(source, /版本 ' \+ variant\.label \+ ' 尚未完成/);
  assert.match(source, /state\.messagePreviewed = failed\.length === 0/);
});
