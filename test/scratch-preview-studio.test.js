// 刮刮樂頁面：畫面設定（rules.ui.scratch / rules.ui.copy）、後台安全預覽、兌獎事項與分享卡片。
// 安全預覽的鐵律：不呼叫 play / meta / referral / event；所有情境只在瀏覽器裡演出。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const PRIZES = [
  { id: 21, name: '拿鐵買一送一', description: '限內用', image_url: null, position: 1, is_grand_prize: false,
    prize_type: 'coupon_code', prize_value: { redeem_note: '結帳前出示此畫面\n每人限用一次' } },
  { id: 22, name: '【頭獎】雙人套餐', description: '', image_url: 'https://example.test/grand.png', position: 2, is_grand_prize: true,
    prize_type: 'physical', prize_value: { redeem_note: '客服會私訊聯絡' } },
  { id: 23, name: '銘謝惠顧', description: '', image_url: null, position: 3, is_grand_prize: false,
    prize_type: 'none', prize_value: { redeem_note: '不該顯示' } }
];

function fakeCtx(record) {
  const n = () => {};
  let fillStyle = '';
  return {
    setTransform: n, fillRect: n, beginPath: n, arc: n, fill: n, moveTo: n, lineTo: n, stroke: n,
    clearRect: n, save: n, restore: n, translate: n, rotate: n, drawImage: n, scale: n,
    createLinearGradient: () => ({ addColorStop: (o, c) => record.stops.push(c) }),
    fillText: (t) => record.texts.push(t),
    getImageData: () => ({ data: new Uint8ClampedArray(4 * 64) }),
    set fillStyle(v) { fillStyle = v; }, get fillStyle() { return fillStyle; },
    globalCompositeOperation: '', globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    lineWidth: 1, lineCap: '', lineJoin: ''
  };
}

async function renderScratch(scenario, ui, previewUi, opts) {
  const activity = {
    id: 9, slug: 'summer-scratch', name: '夏日刮刮樂', description: '刮開就知道',
    cover_image_url: (opts && opts.cover) || null,
    game_type: 'scratch', status: 'active', base_plays_per_user: 2,
    referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1,
    rules: ui ? { ui } : {}
  };
  const html = await ejs.renderFile(path.join(REPO, 'views/game_scratch.ejs'), {
    title: '夏日刮刮樂', bodyClass: '', activity, prizes: PRIZES, liffId: 'test-liff', gameType: 'scratch', addFriendUrl: ''
  });
  const calls = [];
  const record = { stops: [], texts: [] };
  const params = new URLSearchParams({ preview: '1', preview_scenario: scenario });
  if (previewUi) params.set('preview_ui', JSON.stringify(previewUi));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/games/scratch/summer-scratch?' + params.toString(),
    beforeParse(window) {
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => fakeCtx(record);
      window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 320, height: 240, left: 0, top: 0 });
      window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 320, height: 240, left: 0, top: 0 });
      window.fetch = (...args) => {
        calls.push(args);
        return Promise.reject(new Error('安全預覽不該呼叫 API'));
      };
      window.liff = { getIDToken: () => '', isApiAvailable: () => false };
    }
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  return { dom, document: dom.window.document, window: dom.window, calls, record };
}

test('安全預覽完全不呼叫任何 API，且顯示預覽橫幅', async () => {
  const { document, calls } = await renderScratch('first_open');
  assert.equal(calls.length, 0);
  assert.equal(document.getElementById('preview-banner').hidden, false);
  assert.match(document.getElementById('stat-remaining').textContent, /^2/);
  // 首次開啟：卡片蓋著、可揭曉、沒有「再來一張」
  assert.equal(document.getElementById('card').classList.contains('ready'), true);
  assert.equal(document.getElementById('reveal-btn').hidden, false);
});

test('抽中情境會揭曉獎名與獎品層級的兌獎事項；銘謝惠顧不顯示兌獎事項', async () => {
  const win = await renderScratch('prize:21');
  assert.equal(win.calls.length, 0);
  assert.equal(win.document.getElementById('prize-name').textContent, '拿鐵買一送一');
  const note = win.document.getElementById('prize-redeem-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /結帳前出示此畫面/);
  assert.equal(win.document.getElementById('card').classList.contains('revealed'), true);

  const lose = await renderScratch('prize:23');
  assert.equal(lose.document.getElementById('prize-redeem-note').hidden, true);
  assert.equal(lose.document.getElementById('prize-name').textContent, '銘謝惠顧');
});

test('頭獎顯示獎品圖片並套用大獎樣式', async () => {
  const { document } = await renderScratch('prize:22');
  const glyph = document.getElementById('prize-glyph');
  assert.equal(glyph.classList.contains('has-image'), true);
  assert.equal(glyph.querySelector('img').getAttribute('src'), 'https://example.test/grand.png');
  assert.equal(document.getElementById('prize').classList.contains('grand'), true);
});

test('rules.ui 的刮膜配色、比例、提示字與文案會套進畫面', async () => {
  const ui = {
    logo_url: 'https://example.test/logo.png',
    scratch: { style: 'custom', custom: { foil_1: '#111111', foil_2: '#222222', foil_3: '#333333' }, ratio: '16:9', reveal_threshold: 50, show_stats: false },
    copy: { stage_label: '刮一下', cover_text: '往這裡刮', reveal_button: '直接開', redemption_label: '怎麼兌換', redemption_text: '到店出示即可', share_button: '傳給朋友' }
  };
  const { document, window, record } = await renderScratch('ready', ui);
  const root = window.getComputedStyle(document.documentElement);
  assert.equal(root.getPropertyValue('--foil-1').trim(), '#111111');
  assert.equal(root.getPropertyValue('--card-ratio').trim(), '16 / 9');
  assert.equal(document.getElementById('brand-logo').getAttribute('src'), 'https://example.test/logo.png');
  assert.equal(document.getElementById('stage-label').textContent, '刮一下');
  assert.equal(document.getElementById('reveal-btn').textContent, '直接開');
  assert.equal(document.getElementById('share-btn-label').textContent, '傳給朋友');
  assert.equal(document.getElementById('stats-row').hidden, true);
  assert.ok(record.stops.includes('#111111') && record.stops.includes('#333333'));
  assert.ok(record.texts.includes('往這裡刮'));
  const details = document.getElementById('redeem-details');
  assert.equal(details.hidden, false);
  assert.equal(document.getElementById('redeem-summary').textContent, '怎麼兌換');
  assert.match(document.getElementById('redeem-body').textContent, /到店出示即可/);
});

test('沒有兌獎說明時不顯示兌獎區；非法顏色與網址退回預設', async () => {
  const ui = { logo_url: 'javascript:alert(1)', scratch: { style: 'gold', custom: { foil_1: 'red' } } };
  const { document, window } = await renderScratch('ready', ui);
  assert.equal(document.getElementById('redeem-details').hidden, true);
  assert.equal(document.getElementById('brand-logo').getAttribute('src'), '/images/openrice-wordmark.png');
  const root = window.getComputedStyle(document.documentElement);
  assert.equal(root.getPropertyValue('--foil-1').trim(), '#FFE082');
});

test('preview_ui 可在未存檔前覆寫畫面設定', async () => {
  const { document, window } = await renderScratch('ready', { scratch: { style: 'silver' } }, {
    scratch: { style: 'brand' }, copy: { stage_label: '預覽中的標題' }
  });
  const root = window.getComputedStyle(document.documentElement);
  assert.equal(root.getPropertyValue('--foil-1').trim(), '#FCC726');
  assert.equal(document.getElementById('stage-label').textContent, '預覽中的標題');
});

test('分享卡片是 Flex Message，封面／標題／說明沿用活動，CTA 保留 ref', async () => {
  const { window } = await renderScratch('ready', { copy: { share_cta: '來刮一張', share_card_desc: '限時三天' } }, null, { cover: 'https://example.test/cover.jpg' });
  const built = window.__scratchBuildShare();
  assert.equal(built.url, 'https://liff.line.me/test-liff/scratch/summer-scratch?ref=PREVIEW');
  const flex = built.flex;
  assert.equal(flex.type, 'flex');
  assert.equal(flex.contents.hero.url, 'https://example.test/cover.jpg');
  assert.equal(flex.contents.hero.action.uri, built.url);
  const button = flex.contents.footer.contents[0];
  assert.equal(button.action.type, 'uri');
  assert.equal(button.action.label, '來刮一張');
  assert.match(button.action.uri, /\?ref=PREVIEW$/);
  assert.equal(flex.contents.body.contents[0].text, '夏日刮刮樂');
  assert.equal(flex.contents.body.contents[1].text, '限時三天');
});

test('沒有 https 封面時分享卡片不帶 hero，避免 LINE 拒收', async () => {
  const { window } = await renderScratch('ready');
  const built = window.__scratchBuildShare();
  assert.equal(built.flex.contents.hero, undefined);
  assert.match(built.flex.altText, /夏日刮刮樂/);
});

test('次數用完的預覽情境把卡片切成已用完，不顯示揭曉鈕', async () => {
  const { document, calls } = await renderScratch('done');
  assert.equal(calls.length, 0);
  assert.equal(document.getElementById('card').classList.contains('exhausted'), true);
  assert.equal(document.getElementById('reveal-btn').hidden, true);
  assert.equal(document.getElementById('card-loading-text').textContent, '次 數 已 用 完');
});
