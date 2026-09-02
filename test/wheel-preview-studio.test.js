const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const PRIZES = [
  { id: 11, name: '【26,000 哩】頭獎', position: 1, is_grand_prize: true, description: '亞洲萬里通里數', image_url: null },
  { id: 15, name: 'Rice Dollar $30', position: 2, is_grand_prize: false, description: 'OpenRice App 內使用', image_url: null },
  { id: 17, name: '銘謝惠顧', position: 3, is_grand_prize: false, description: '這是內部備註，不可顯示', image_url: null }
];

function fakeCtx() {
  const n = () => {};
  return {
    clearRect: n, beginPath: n, moveTo: n, closePath: n, fill: n, stroke: n,
    arc: n, lineTo: n, save: n, restore: n, fillText: n,
    measureText: t => ({ width: String(t).length * 11 }),
    set font(v) {}, get font() { return ''; }, fillStyle: '', strokeStyle: '', lineWidth: 1,
    textAlign: '', textBaseline: '', globalAlpha: 1, lineJoin: '', lineCap: ''
  };
}

async function openScenario(scenario) {
  const activity = {
    id: 6, slug: 'share-miles', name: '分享超有哩', description: '分享越多，機會越多',
    game_type: 'wheel', status: 'active', base_plays_per_user: 1,
    referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1
  };
  const html = await ejs.renderFile(path.join(REPO, 'views/game_wheel.ejs'), {
    title: '分享超有哩', activity, prizes: PRIZES, liffId: 'test-liff', addFriendUrl: ''
  });
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/games/wheel/share-miles?preview=1&preview_scenario=' + encodeURIComponent(scenario),
    beforeParse(window) {
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      window.fetch = (...args) => {
        calls.push(args);
        return Promise.reject(new Error('安全預覽不該呼叫 API'));
      };
    }
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  return { dom, document: dom.window.document, calls };
}

test('安全預覽可切換主要 UX 狀態，而且不呼叫任何 API', async () => {
  const cases = [
    ['ready', doc => assert.equal(doc.getElementById('stat-remaining').textContent, '3')],
    ['last', doc => assert.equal(doc.getElementById('stat-remaining').textContent, '1')],
    ['invite', doc => assert.equal(doc.getElementById('cta-spin').textContent, '找朋友')],
    ['done', doc => assert.equal(doc.getElementById('cta-spin').textContent, '本次活動已完成')],
    ['history', doc => assert.equal(doc.getElementById('myprize').hidden, false)],
    ['redemption', doc => assert.equal(doc.getElementById('redeem-details').open, true)]
  ];

  for (const [scenario, verify] of cases) {
    const { dom, document, calls } = await openScenario(scenario);
    assert.equal(document.getElementById('preview-banner').hidden, false);
    verify(document);
    assert.equal(calls.length, 0, scenario + ' 不應讀寫正式 API');
    dom.window.close();
  }
});

test('每一個獎項都能直接預覽中獎畫面，結果也會留在同頁', async () => {
  const { dom, document, calls } = await openScenario('prize:11');
  assert.equal(document.getElementById('modal-prize').textContent, '【26,000 哩】頭獎');
  assert.ok(document.getElementById('modal').classList.contains('open'));
  assert.equal(document.getElementById('myprize').hidden, false);
  assert.match(document.getElementById('myprize').textContent, /26,000 哩/);
  assert.equal(calls.length, 0);
  dom.window.close();
});

test('測試畫面的按鈕不會意外送出抽獎或分享', async () => {
  const { dom, document, calls } = await openScenario('ready');
  document.getElementById('cta-spin').click();
  document.getElementById('invite-btn').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  assert.match(document.getElementById('status').textContent, /安全測試/);
  dom.window.close();
});

