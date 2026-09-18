const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function renderSequencePage(recipients) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_message_sequence.ejs'), {
    title: '多段訊息編輯器',
    bodyClass: 'admin-shell messages-shell',
    user: 'admin',
    isAdmin: true
  }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://crm.example/admin/messages/sequence',
    pretendToBeVisual: true
  });
  const requests = [];
  dom.window.fetch = async (url, options = {}) => {
    if (url === '/admin/broadcast/test-recipients') {
      return { json: async () => ({ ok: true, recipients }) };
    }
    if (url === '/admin/messages/api/list') {
      return { json: async () => ({ ok: true, messages: [] }) };
    }
    if (url === '/admin/broadcast/test-push') {
      requests.push(JSON.parse(options.body || '{}'));
      return { json: async () => ({ ok: true }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  const script = Array.from(dom.window.document.scripts)
    .find(node => node.textContent.includes('function loadTestRecipients'));
  assert.ok(script, '應找到多段訊息編輯器程式');
  dom.window.eval(script.textContent);
  await wait(30);
  return { dom, requests };
}

test('多段訊息可選既有測試人員，並把指定 LINE User ID 傳給測試 API', async () => {
  const henUid = `U${'a'.repeat(32)}`;
  const iceUid = `U${'b'.repeat(32)}`;
  const { dom, requests } = await renderSequencePage([
    { id: 1, label: 'Hen', line_user_id: henUid },
    { id: 2, label: 'Ice', line_user_id: iceUid }
  ]);
  const { document } = dom.window;
  const select = document.getElementById('msq-test-recipient');
  const button = document.getElementById('msq-test');

  assert.doesNotMatch(document.body.textContent, /發給我自己測試/);
  assert.match(document.body.textContent, /選擇測試人員發送確認/);
  assert.equal(select.disabled, false);
  assert.deepEqual(Array.from(select.options).map(option => option.textContent), ['Hen', 'Ice']);
  assert.equal(button.disabled, false);

  document.querySelector('[data-add="text"]').click();
  const textarea = document.querySelector('[data-f="text"]');
  textarea.value = '先發文字，再發卡片';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  select.value = iceUid;
  button.click();
  await wait(30);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].test_line_user_id, iceUid);
  assert.equal(requests[0].message_config.mode, 'sequence');
  assert.equal(requests[0].message_config.items[0].text, '先發文字，再發卡片');
  assert.match(document.getElementById('msq-status').textContent, /已發給 Ice/);
  dom.window.close();
});

test('沒有測試人員時明確提示並停用發送，不再送出 no_recipient 請求', async () => {
  const { dom, requests } = await renderSequencePage([]);
  const { document } = dom.window;
  const select = document.getElementById('msq-test-recipient');
  const button = document.getElementById('msq-test');

  assert.equal(select.disabled, true);
  assert.equal(button.disabled, true);
  assert.match(select.textContent, /尚未設定測試人員/);
  assert.match(document.getElementById('msq-status').textContent, /管理測試人員/);
  button.click();
  await wait(10);
  assert.equal(requests.length, 0);
  dom.window.close();
});
