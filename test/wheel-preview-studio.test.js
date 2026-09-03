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

async function renderWheel(scenario, ui, previewUi) {
  const activity = {
    id: 6, slug: 'share-miles', name: '分享超有哩', description: '分享越多，機會越多',
    game_type: 'wheel', status: 'active', base_plays_per_user: 1,
    referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1,
    rules: ui ? { ui } : {}
  };
  const html = await ejs.renderFile(path.join(REPO, 'views/game_wheel.ejs'), {
    title: '分享超有哩', activity, prizes: PRIZES, liffId: 'test-liff', addFriendUrl: ''
  });
  const calls = [];
  const params = new URLSearchParams({ preview: '1', preview_scenario: scenario });
  if (previewUi) params.set('preview_ui', JSON.stringify(previewUi));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/games/wheel/share-miles?' + params.toString(),
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

async function openScenario(scenario) {
  return renderWheel(scenario);
}

test('後台輪盤編輯器提供完整控制項', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_edit.ejs'), {
    title: '編輯活動', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activityId: 6,
    gameTypes: ['wheel', 'claim'],
    statuses: ['draft', 'active', 'paused', 'ended'],
    prizeTypes: ['coupon_code', 'badge', 'none']
  }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('.ae-color-control input[type="color"]').length, 9);
  assert.equal(document.querySelectorAll('.ae-range-control input[type="range"]').length, 2);
  assert.equal(document.querySelectorAll('.ae-copy-grid input, .ae-copy-grid textarea').length, 24);
  assert.ok(document.querySelector('#ae-wheel-style option[value="custom"]'));
  assert.ok(document.getElementById('ae-save-visual'));
  assert.match(html, /preview_ui/);
  dom.window.close();
});

test('安全預覽可切換主要 UX 狀態，而且不呼叫任何 API', async () => {
  const cases = [
    ['first_open', doc => assert.equal(doc.getElementById('stat-remaining').textContent, '1')],
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

test('活動可關閉右上插圖、換 Logo 並套用輪盤樣式', async () => {
  const { dom, document, calls } = await renderWheel('first_open', {
    show_hero_art: false,
    logo_url: 'https://cdn.example.test/campaign-logo.png',
    wheel_style: 'clean'
  });
  assert.equal(document.querySelector('.hero .art').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('.logo-img').getAttribute('src'), 'https://cdn.example.test/campaign-logo.png');
  assert.ok(document.getElementById('stage').classList.contains('wheel-style-clean'));
  assert.equal(calls.length, 0);
  dom.window.close();
});

test('分享超有哩預設移除右上插圖', async () => {
  const { dom, document } = await renderWheel('first_open');
  assert.equal(document.querySelector('.hero .art').hasAttribute('hidden'), true);
  assert.ok(document.querySelector('.hero').classList.contains('no-art'));
  dom.window.close();
});

test('自訂輪盤可調整顏色、尺寸與線條粗細', async () => {
  const custom = {
    slice_1: '#112233', slice_2: '#DDEEFF', grand: '#F9C73B',
    text: '#223344', line: '#334455', highlight: '#F15A22',
    pointer: '#AA2200', pointer_dot: '#FFD500', hub: '#FAFAFA',
    size: 348, line_width: 7
  };
  const { dom, document, calls } = await renderWheel('first_open', {
    show_hero_art: false,
    wheel_style: 'custom',
    wheel_custom: custom
  });
  const stage = document.getElementById('stage');
  assert.ok(stage.classList.contains('wheel-style-custom'));
  assert.equal(stage.style.getPropertyValue('--wheel-size'), '348px');
  assert.equal(stage.style.getPropertyValue('--wheel-line-width'), '7px');
  assert.equal(stage.style.getPropertyValue('--wheel-pointer'), '#AA2200');
  assert.equal(calls.length, 0);
  dom.window.close();
});

test('後台未儲存的視覺調整也能即時出現在安全預覽', async () => {
  const previewUi = {
    show_hero_art: true,
    logo_url: 'https://cdn.example.test/live-logo.png',
    wheel_style: 'custom',
    wheel_custom: {
      slice_1: '#123456', slice_2: '#FEDCBA', grand: '#F9C73B',
      text: '#222222', line: '#345678', highlight: '#F15A22',
      pointer: '#AABBCC', pointer_dot: '#DDEEFF', hub: '#FFFFFF',
      size: 352, line_width: 6.5
    }
  };
  const { dom, document, calls } = await renderWheel('first_open', null, previewUi);
  const stage = document.getElementById('stage');
  assert.equal(document.querySelector('.hero .art').hasAttribute('hidden'), false);
  assert.equal(document.querySelector('.logo-img').getAttribute('src'), 'https://cdn.example.test/live-logo.png');
  assert.equal(stage.style.getPropertyValue('--wheel-size'), '352px');
  assert.equal(stage.style.getPropertyValue('--wheel-line-width'), '6.5px');
  assert.equal(stage.style.getPropertyValue('--wheel-line'), '#345678');
  assert.equal(calls.length, 0);
  dom.window.close();
});

test('活動儲存的提示文案會套用並自動帶入動態資料', async () => {
  const { dom, document, calls } = await renderWheel('first_open', {
    copy: {
      remaining_lead: '幸運機會還有',
      remaining_unit: '次喔',
      greeting: '歡迎來玩，{{name}}！',
      spin_button: '開始抽好運',
      invite_title: '邀朋友一起收藏好運',
      invite_progress: '現在 {{invited}} 位，再 {{next}} 位就多 {{bonus}} 次，還有 {{left}} 次',
      invite_count: '目前已有 {{invited}} 位朋友',
      invite_button: '分享好運'
    }
  });
  assert.equal(document.getElementById('stat-lead').textContent, '幸運機會還有');
  assert.equal(document.getElementById('stat-unit').textContent, '次喔');
  assert.equal(document.getElementById('status').textContent, '歡迎來玩，第一次來的用戶！');
  assert.equal(document.getElementById('cta-spin').textContent, '開始抽好運');
  assert.equal(document.getElementById('invite-title').textContent, '邀朋友一起收藏好運');
  assert.equal(document.getElementById('invite-meta').textContent, '目前已有 0 位朋友');
  assert.match(document.getElementById('invite-sub').textContent, /再 1 位就多 1 次/);
  assert.equal(document.getElementById('invite-btn').textContent, '分享好運');
  assert.equal(calls.length, 0);
  dom.window.close();
});

test('後台未儲存的文案也會即時出現在中獎預覽', async () => {
  const { dom, document, calls } = await renderWheel('prize:11', null, {
    copy: {
      winner_eyebrow: '好運被你接住了',
      result_close: '收下好運',
      history_title: '我的好運紀錄',
      history_note: '你的結果已安心收在這裡'
    }
  });
  assert.equal(document.getElementById('modal-eyebrow').textContent, '好運被你接住了');
  assert.equal(document.getElementById('modal-close').textContent, '收下好運');
  assert.match(document.querySelector('.myprize-head').textContent, /^我的好運紀錄/);
  assert.equal(document.querySelector('.myprize-note').textContent, '你的結果已安心收在這裡');
  assert.equal(calls.length, 0);
  dom.window.close();
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
