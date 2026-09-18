'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function renderBroadcast() {
  return ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '傳訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false,
    msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
}

test('群發預設一次只顯示一個步驟，確認收件人後才進訊息步驟', async () => {
  const html = await renderBroadcast();
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast', pretendToBeVisual: true
  });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async url => {
    if (url === '/admin/broadcast/test-recipients') return { json: async () => ({ ok: true, recipients: [] }) };
    if (url === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: [] }) };
    if (url === '/admin/broadcast/audience/preview') {
      return { json: async () => ({ ok: true, total: 12, eligibleTotal: 12, sendTotal: 12, sample: [] }) };
    }
    if (url === '/admin/broadcast/preview-message') return { json: async () => ({ ok: false, error: '尚未建立訊息' }) };
    return { json: async () => ({ ok: true }) };
  };

  window.eval(source);
  await wait(40);

  assert.equal(window.document.getElementById('bc-channel-step').hidden, false);
  assert.equal(window.document.getElementById('bc-audience-step').hidden, true);
  assert.equal(window.document.querySelector('.broadcast-preview-side').hidden, true, '選管道時不應讓預覽分心');

  window.document.querySelector('#bc-channel-step .bc-next').click();
  assert.equal(window.document.getElementById('bc-channel-step').hidden, true);
  assert.equal(window.document.getElementById('bc-audience-step').hidden, false);

  window.document.querySelector('#bc-audience-step .bc-next').click();
  await wait(30);
  assert.equal(window.document.getElementById('bc-message-step').hidden, false, '確認有 12 位收件人後應自動進下一步');
  assert.equal(window.document.getElementById('bc-progress-audience').textContent, '12 人');
  assert.equal(window.document.querySelector('.broadcast-preview-side').hidden, false, '做訊息時才顯示預覽');

  window.document.getElementById('bc-full-mode').click();
  assert.equal(window.document.getElementById('bc-channel-step').hidden, false);
  assert.equal(window.document.getElementById('bc-send-step').hidden, false);
  assert.equal(window.document.getElementById('bc-full-mode').textContent, '回到一步一步模式');
  dom.window.close();
});

test('建立名單必須先命名，再加入對象，最後才顯示建立按鈕', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_recipient_lists.ejs'), {
    title: '名單庫', bodyClass: 'admin-shell recipient-lists-shell', user: 'admin', isAdmin: true
  }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://crm.example/admin/recipient-lists', pretendToBeVisual: true,
    beforeParse(window) {
      window.alert = () => {};
      window.confirm = () => true;
      window.fetch = async url => {
        if (url === '/admin/recipient-lists/api/catalog') return { json: async () => ({ ok: true, tags: [], activities: [], menus: [], broadcasts: [] }) };
        if (url === '/admin/broadcast/recipient-lists') return { json: async () => ({ ok: true, lists: [] }) };
        if (url === '/admin/recipient-lists/api/breakdowns') return { json: async () => ({ ok: true, breakdowns: {} }) };
        return { json: async () => ({ ok: true, total: 0 }) };
      };
    }
  });
  const { window } = dom;
  await wait(80);
  window.document.getElementById('btn-new-list').click();

  assert.equal(window.document.querySelector('[data-nl-panel="1"]').hidden, false);
  assert.equal(window.document.querySelector('[data-nl-panel="2"]').hidden, true);
  assert.equal(window.document.getElementById('nl-save').hidden, true);

  window.document.getElementById('nl-next').click();
  assert.equal(window.document.getElementById('nl-status').textContent, '先替這份名單取一個名稱');
  assert.equal(window.document.querySelector('[data-nl-panel="1"]').hidden, false);

  window.document.getElementById('nl-name').value = '近 7 天新好友';
  window.document.getElementById('nl-next').click();
  assert.equal(window.document.querySelector('[data-nl-panel="2"]').hidden, false);
  window.document.getElementById('nl-uids').value = 'U12345678901234567890123456789012';
  window.document.getElementById('nl-uids').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('nl-next').click();

  assert.equal(window.document.querySelector('[data-nl-panel="3"]').hidden, false);
  assert.equal(window.document.getElementById('nl-save').hidden, false);
  assert.match(window.document.getElementById('nl-review').textContent, /近 7 天新好友/);
  assert.match(window.document.getElementById('nl-review').textContent, /1 位 LINE 用戶/);
  dom.window.close();
});
