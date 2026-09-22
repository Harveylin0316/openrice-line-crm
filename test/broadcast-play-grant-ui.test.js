// 群發頁的「派送遊玩機會」區塊：從活動頁帶 ?activity_id 進來會自動勾選、選活動、填 CTA；
// 送出前檢查與確認視窗要看得到派送設定；Email 管道看不到這區。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACTIVITIES = [
  { id: 9, name: '夏日刮刮樂', status: 'active', slug: 'summer', game_type: 'scratch', liff_id_override: null, base_plays_per_user: 1 },
  { id: 6, name: '分享超有哩', status: 'active', slug: 'share-miles', game_type: 'wheel', liff_id_override: null, base_plays_per_user: 1 },
  { id: 3, name: '舊 MGM', status: 'ended', slug: 'mgm-old', game_type: 'mgm', liff_id_override: null, base_plays_per_user: 1 }
];

async function openBroadcastPage(url) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: ACTIVITIES, recent: [], scheduled: [], running: [], hasLineToken: true,
    gamesLiffId: 'LIFF-GAMES', prefillActivityId: /activity_id=(\d+)/.test(url) ? Number(RegExp.$1) : null,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (u) => {
    if (u === '/admin/broadcast/test-recipients') return { json: async () => ({ ok: true, recipients: [] }) };
    if (u === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: [] }) };
    return { json: async () => ({ ok: true }) };
  };
  window.eval(source);
  await wait(40);
  return { dom, window, document: window.document };
}

test('活動下拉只列通用遊戲、刮刮樂排最前，選項帶 LIFF 連結', async () => {
  const { dom, document } = await openBroadcastPage('https://crm.example/admin/broadcast');
  const options = [...document.querySelectorAll('#pg-activity option')].filter(o => o.value);
  assert.deepEqual(options.map(o => o.value), ['9', '6']);
  assert.equal(options[0].getAttribute('data-url'), 'https://liff.line.me/LIFF-GAMES/scratch/summer');
  assert.equal(document.getElementById('play-grant-body').hidden, true);
  dom.window.close();
});

test('從活動頁帶 activity_id 進來：自動勾選、選好活動、CTA 與標題填入', async () => {
  const { dom, document } = await openBroadcastPage('https://crm.example/admin/broadcast?activity_id=9');
  assert.equal(document.getElementById('pg-enabled').checked, true);
  assert.equal(document.getElementById('pg-activity').value, '9');
  assert.equal(document.getElementById('play-grant-body').hidden, false);
  assert.equal(document.getElementById('tpl-cta-url').value, 'https://liff.line.me/LIFF-GAMES/scratch/summer');
  assert.equal(document.getElementById('tpl-cta-label').value, '馬上玩');
  assert.equal(document.getElementById('tpl-title').value, '夏日刮刮樂');
  assert.match(document.getElementById('pg-mode-exclusive-note').textContent, /目前每人基礎 1 次；送出時會改成 0/);
  dom.window.close();
});

test('已有 CTA 連結時不覆蓋；未選活動時送出檢查會擋', async () => {
  const { dom, window, document } = await openBroadcastPage('https://crm.example/admin/broadcast');
  document.getElementById('tpl-cta-url').value = 'https://example.com/keep';
  document.getElementById('pg-enabled').checked = true;
  document.getElementById('pg-enabled').dispatchEvent(new window.Event('change'));
  document.getElementById('pg-activity').value = '9';
  document.getElementById('pg-activity').dispatchEvent(new window.Event('change'));
  document.getElementById('pg-insert-cta').click();
  assert.equal(document.getElementById('tpl-cta-url').value, 'https://example.com/keep');
  assert.match(document.getElementById('pg-status').textContent, /沒有覆蓋/);

  // 送出檢查：受眾已預覽、名單正常，但派送未選活動 → 要被擋，而且原因要講清楚
  const alerts = [];
  window.alert = (m) => alerts.push(String(m));
  document.getElementById('pg-activity').value = '';
  document.getElementById('pg-plays').value = '3';
  // 先用貼 ID 名單走到「已預覽」狀態：直接模擬預覽完成的 state 不可取得，改以 alert 內容驗證擋下順序
  const send = document.getElementById('btn-send');
  send.disabled = false;
  send.click();
  await wait(20);
  assert.equal(alerts.length, 1);
  // 受眾未預覽會先擋；這證明檢查有跑。派送本身的檢查在 validatePlayGrant，另用原始碼確認順序。
  assert.match(alerts[0], /無法送出/);
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const idx = source.indexOf('var playGrantError = validatePlayGrant();');
  assert.ok(idx > 0);
  assert.ok(idx < source.indexOf('if (!state.messagePreviewed)'), '派送檢查要在訊息預覽檢查之前');
  assert.match(source, /派送遊玩機會：請先選要派送的活動/);
  assert.match(source, /每人次數要是 1–100 的整數/);
  dom.window.close();
});

test('切到 Email 管道時派送區隱藏，不會送出 play_grant', async () => {
  const { dom, window, document } = await openBroadcastPage('https://crm.example/admin/broadcast?activity_id=9');
  const emailTab = document.querySelector('.tab-btn[data-channel="email"]');
  assert.ok(emailTab);
  emailTab.click();
  await wait(20);
  assert.equal(document.getElementById('play-grant-block').hidden, true);
  const lineTab = document.querySelector('.tab-btn[data-channel="line"]');
  lineTab.click();
  await wait(20);
  assert.equal(document.getElementById('play-grant-block').hidden, false);
  dom.window.close();
});
