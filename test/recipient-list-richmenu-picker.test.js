'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { buildRichMenuCatalog } = require('../src/routes/adminRecipientLists');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('圖文選單目錄只提供人看得懂的選單、分頁與按鈕名稱', () => {
  const catalog = buildRichMenuCatalog([{
    id: 3,
    name: '中秋主選單',
    status: 'published',
    published_config: {
      tabs: [
        { label: '活動', buttons: [
          { label: '中秋開飯驚喜', action: { type: 'uri', uri: 'https://example.com/moon' } },
          { action: { type: 'message', text: '查詢訂位' } }
        ] },
        { label: '會員', buttons: [{ action: { type: 'uri', label: '我的優惠券' } }] }
      ]
    }
  }]);

  assert.deepEqual(catalog, [{
    id: 3,
    name: '中秋主選單',
    status: 'published',
    tabs: [
      { index: 0, label: '活動', buttons: [
        { index: 0, label: '中秋開飯驚喜' },
        { index: 1, label: '查詢訂位' }
      ] },
      { index: 1, label: '會員', buttons: [{ index: 0, label: '我的優惠券' }] }
    ]
  }]);
});

test('使用者以選單、分頁、按鈕名稱操作，試算仍送出正確底層條件', async () => {
  const repo = path.join(__dirname, '..');
  const html = await ejs.renderFile(path.join(repo, 'views/admin_recipient_lists.ejs'), {
    title: '名單庫', bodyClass: 'admin-shell recipient-lists-shell', user: 'admin', isAdmin: true
  }, { views: [path.join(repo, 'views')] });
  const previews = [];
  const catalog = {
    ok: true,
    tags: [], activities: [], broadcasts: [],
    menus: [{
      id: 3, name: '中秋主選單', status: 'published',
      tabs: [
        { index: 0, label: '活動', buttons: [{ index: 0, label: '分享超有哩' }] },
        { index: 1, label: '會員', buttons: [{ index: 0, label: '我的優惠券' }] }
      ]
    }]
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://crm.example/admin/recipient-lists',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.alert = () => {};
      window.confirm = () => true;
      window.fetch = async (url, options = {}) => {
        if (url === '/admin/recipient-lists/api/catalog') return { json: async () => catalog };
        if (url === '/admin/broadcast/recipient-lists') return { json: async () => ({ ok: true, lists: [] }) };
        if (url === '/admin/recipient-lists/api/breakdowns') return { json: async () => ({ ok: true, breakdowns: {} }) };
        if (url === '/admin/recipient-lists/api/dynamic/preview') {
          previews.push(JSON.parse(options.body || '{}'));
          return { json: async () => ({ ok: true, total: 12, examples: [] }) };
        }
        return { json: async () => ({ ok: true }) };
      };
    }
  });
  const { window } = dom;
  await wait(120);

  window.document.getElementById('btn-new-list').click();
  const dynamic = window.document.querySelector('input[name="nl-type"][value="dynamic"]');
  dynamic.checked = true;
  dynamic.dispatchEvent(new window.Event('change', { bubbles: true }));

  const type = window.document.querySelector('.aud-type');
  type.value = 'rich_menu_button';
  type.dispatchEvent(new window.Event('change', { bubbles: true }));

  const menu = window.document.querySelector('.aud-rm-menu');
  menu.value = '3';
  menu.dispatchEvent(new window.Event('change', { bubbles: true }));
  const tab = window.document.querySelector('.aud-rm-tab');
  tab.value = '1';
  tab.dispatchEvent(new window.Event('change', { bubbles: true }));
  const button = window.document.querySelector('.aud-rm-button');
  button.value = '0';
  button.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(window.document.querySelector('.aud-value').value, '3:1:0');
  assert.match(window.document.querySelector('.aud-rm-hint').textContent, /中秋主選單 › 會員 › 我的優惠券/);
  assert.doesNotMatch(window.document.getElementById('new-list-modal').textContent, /選單編號:分頁:格子/);

  window.document.getElementById('aud-preview').click();
  await wait(80);
  assert.equal(previews.at(-1).definition.conditions[0].value, '3:1:0');
  assert.match(window.document.getElementById('aud-preview-result').textContent, /12/);
  dom.window.close();
});
