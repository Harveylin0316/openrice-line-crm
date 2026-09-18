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

function flexCardWithCta(url = 'https://example.com/old') {
  return {
    type: 'flex',
    altText: 'CTA 測試卡片',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'box', layout: 'vertical', backgroundColor: '#FCC726',
          action: { type: 'uri', label: '立即查看', uri: url },
          contents: [{ type: 'text', text: '立即查看', align: 'center', weight: 'bold' }]
        }]
      }
    }
  };
}

function flexCardWithVisualButtonOnly() {
  return {
    type: 'flex',
    altText: '尚未設定 CTA 的卡片',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'box', layout: 'vertical', backgroundColor: '#FCC726',
          paddingAll: 'md', cornerRadius: '8px',
          contents: [{ type: 'text', text: '開始抽獎', align: 'center', weight: 'bold' }]
        }]
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

test('訊息庫的既有 CTA 會顯示可編輯 URL，套用後同步 JSON 與預覽且不受群發 A/B 草稿污染', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '編輯訊息', bodyClass: 'admin-shell broadcast-shell msglib-mode', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: true,
    msgLibId: '7', msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const flex = flexCardWithCta();
  const previewBodies = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://crm.example/admin/broadcast?msglib=1&mid=7',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/test-recipients') return { json: async () => ({ ok: true, recipients: [] }) };
    if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: [] }) };
    if (url === '/admin/messages/api/7') {
      return { json: async () => ({ ok: true, message: { id: 7, name: 'CTA 卡片', message_config: { mode: 'flex_json', flex } } }) };
    }
    if (url === '/admin/broadcast/preview-message') {
      const body = JSON.parse(options.body || '{}');
      previewBodies.push(body.message_config);
      return { json: async () => ({ ok: true, channel: 'line', messages: [body.message_config.flex] }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  window.localStorage.setItem('broadcast_draft_v1', JSON.stringify({
    abEnabled: true,
    campaign: { enabled: true, variantCount: 2, a: '10', b: '10', c: '0', holdout: '80' },
    variantB: { flexJson: JSON.stringify(flexCardWithCta('https://example.com/wrong-b')) },
    _t: Date.now()
  }));
  window.eval(source);
  await wait(750);

  const helper = window.document.getElementById('json-url-helper');
  const input = helper.querySelector('.jur-input');
  assert.equal(helper.hidden, false, '有既有網址的 CTA 也必須顯示連結編輯器');
  assert.equal(input.value, 'https://example.com/old');
  assert.match(helper.textContent, /立即查看/);
  assert.equal(window.document.getElementById('variant-b-pane').hidden, true, '訊息庫不應載入群發 A\/B 草稿');
  assert.equal(window.document.querySelector('#ab-preview-b'), null, '訊息庫只預覽單一素材');

  input.value = 'https://tw.openrice.com/new-cta';
  helper.querySelector('.jur-apply').click();
  await wait(650);
  const savedFlex = JSON.parse(window.document.getElementById('flex-json').value);
  assert.equal(savedFlex.contents.body.contents[0].action.uri, 'https://tw.openrice.com/new-cta');
  assert.equal(helper.querySelector('.jur-status').textContent, '已設定');
  assert.equal(previewBodies.at(-1).flex.contents.body.contents[0].action.uri, 'https://tw.openrice.com/new-cta');
  dom.window.close();
});

test('只有按鈕外觀但沒有 action 的舊素材，填入 CTA URL 後會建立真正可點擊的 LINE 動作', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '編輯訊息', bodyClass: 'admin-shell broadcast-shell msglib-mode', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: true,
    msgLibId: '38', msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const flex = flexCardWithVisualButtonOnly();
  const previewBodies = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://crm.example/admin/broadcast?msglib=1&mid=38',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/test-recipients') return { json: async () => ({ ok: true, recipients: [] }) };
    if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: [] }) };
    if (url === '/admin/messages/api/38') {
      return { json: async () => ({ ok: true, message: { id: 38, name: '按鈕卡片', message_config: { mode: 'flex_json', flex } } }) };
    }
    if (url === '/admin/broadcast/preview-message') {
      const body = JSON.parse(options.body || '{}');
      previewBodies.push(body.message_config);
      return { json: async () => ({ ok: true, channel: 'line', messages: [body.message_config.flex] }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  window.eval(source);
  await wait(750);

  const helper = window.document.getElementById('json-url-helper');
  const input = helper.querySelector('.jur-input');
  assert.equal(helper.hidden, false, '只有外觀的 CTA 也必須顯示連結編輯器');
  assert.equal(input.value, '');
  assert.match(helper.textContent, /開始抽獎/);
  assert.match(helper.querySelector('.jur-status').textContent, /尚未設定/);

  input.value = 'https://tw.openrice.com/wheel';
  helper.querySelector('.jur-apply').click();
  await wait(650);
  const savedFlex = JSON.parse(window.document.getElementById('flex-json').value);
  const action = savedFlex.contents.body.contents[0].action;
  assert.deepEqual(action, {
    type: 'uri', label: '開始抽獎', uri: 'https://tw.openrice.com/wheel'
  });
  assert.equal(helper.querySelector('.jur-status').textContent, '已設定');
  assert.deepEqual(previewBodies.at(-1).flex.contents.body.contents[0].action, action);
  dom.window.close();
});
