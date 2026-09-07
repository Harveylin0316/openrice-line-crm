const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('後台可選活動，儲存後直接取得三種渠道網址與來源統計', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_flows.ejs'), {
    title: '自動化流程', bodyClass: 'admin-shell flows-shell', user: 'admin', isAdmin: true
  }, { views: [path.join(REPO, 'views')] });
  let savedPayload = null;
  const links = {
    richmenu: 'https://liff.line.me/2000000000-test/ce/31/richmenu',
    broadcast: 'https://liff.line.me/2000000000-test/ce/31/broadcast',
    welcome: 'https://liff.line.me/2000000000-test/ce/31/welcome',
    other: 'https://liff.line.me/2000000000-test/ce/31/other'
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://crm.example/admin/flows',
    beforeParse(w) {
      w.confirm = () => true;
      w.alert = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (url, options = {}) => {
        if (url === '/admin/flows/api/options') return { json: async () => ({
          ok: true, messages: [{ id: 9, name: '活動追蹤訊息' }], lists: [], events: [], rich_menus: [],
          activities: [{ id: 6, name: '分享超有哩', slug: 'share-miles', game_type: 'wheel', status: 'active',
            target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles' }]
        }) };
        if (url === '/admin/flows/api/list') return { json: async () => ({ ok: true, flows: [] }) };
        if (url === '/admin/flows/api/health') return { json: async () => ({ ok: true, flows: [], recentFailed: [] }) };
        if (url === '/admin/flows/api' && options.method === 'POST') {
          savedPayload = JSON.parse(options.body);
          return { json: async () => ({ ok: true, id: 31 }) };
        }
        if (url === '/admin/flows/api/31') return { json: async () => ({ ok: true, flow: {
          id: 31, name: '開啟活動後自動追蹤', status: 'draft', re_enroll: false,
          trigger: { type: 'campaign_open', config: { activity_id: 6, campaign_name: '分享超有哩',
            target_url: 'https://liff.line.me/2000000000-test/wheel/share-miles',
            user_limit: { max: 1, window: 'lifetime' } } },
          steps: [{ type: 'wait', amount: 30, unit: 'minutes' }, { type: 'send', message_id: 9 }],
          tracking_links: links, source_counts: [{ source: 'broadcast', count: 3 }]
        } }) };
        return { json: async () => ({ ok: false }) };
      };
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve));
  await wait(20);
  const doc = dom.window.document;
  doc.querySelector('[data-example="campaign_followup"]').click();
  const activitySelect = doc.getElementById('tc-campaign-activity');
  assert.ok(activitySelect, '活動觸發設定已顯示');
  activitySelect.value = '6';
  activitySelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const messageSelect = doc.querySelector('[data-field="message_id"]');
  messageSelect.value = '9';
  doc.getElementById('fl-save').click();
  await wait(30);

  assert.equal(savedPayload.trigger.type, 'campaign_open');
  assert.equal(savedPayload.trigger.config.activity_id, 6);
  assert.equal(savedPayload.trigger.config.target_url, 'https://liff.line.me/2000000000-test/wheel/share-miles');
  const bodyText = doc.getElementById('fl-trigger-config').textContent;
  assert.match(bodyText, /圖文選單/);
  assert.match(bodyText, /推播訊息/);
  assert.match(bodyText, /歡迎訊息/);
  assert.match(bodyText, /3 人次/);
  const shown = [...doc.querySelectorAll('.fl-campaign-link-row input')].map(x => x.value);
  assert.ok(shown.includes(links.richmenu));
  assert.ok(shown.includes(links.broadcast));
  assert.ok(shown.includes(links.welcome));
  dom.window.close();
});
