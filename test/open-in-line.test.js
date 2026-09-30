'use strict';
// 活動頁不在 LINE 裡打開（電腦、手機 Safari/Chrome）：以前只顯示「請在 LINE App 內打開」就停住。
// 現在電腦顯示 QR Code、手機顯示「用 LINE 開啟」按鈕，邀請碼 ref 一路帶過去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { registerGameType, buildOpenInLineUrl } = require('../src/routes/gamesGeneric');

const REPO = path.join(__dirname, '..');
const MGM_JS = fs.readFileSync(path.join(REPO, 'public/games-mgm.js'), 'utf8');
const REF = 'U' + 'a1'.repeat(16);
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1';
const wait = ms => new Promise(r => setTimeout(r, ms));

const ACT = {
  id: 6, slug: 'share-miles', name: '分享超有哩', description: 'x', cover_image_url: null, status: 'active',
  base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1, rules: {}
};
const PRIZES = [{ id: 1, name: '頭獎', position: 1 }, { id: 2, name: '銘謝惠顧', position: 2 }];

async function openGame(view, gameType, { ua, search }) {
  const html = await ejs.renderFile(path.join(REPO, 'views', view + '.ejs'), {
    title: 'x', bodyClass: '', activity: Object.assign({ game_type: gameType }, ACT), prizes: PRIZES,
    liffId: '2007974193-3AWiL11Y', gameType, addFriendUrl: ''
  });
  const apiCalls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://crm.example/games/' + gameType + '/share-miles' + (search || ''),
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ width: 10, data: [] }), set: () => true });
      window.fetch = (u) => { apiCalls.push(u); return Promise.reject(new Error('no api')); };
      // LIFF SDK 替身：初始化成功，但不在 LINE 裡
      window.liff = { init: async () => {}, isInClient: () => false, isLoggedIn: () => false, login: () => { throw new Error('should not login'); } };
      window.eval(MGM_JS);   // 替代外部 <script src="/games-mgm.js">
    }
  });
  await wait(120);
  return { dom, doc: dom.window.document, apiCalls };
}

test('電腦打開輪盤：顯示 QR Code（帶 ref）與三步驟，隱藏「開始轉」按鈕，不呼叫任何遊戲 API', async () => {
  const { dom, doc, apiCalls } = await openGame('game_wheel', 'wheel', { ua: DESKTOP_UA, search: '?ref=' + REF });
  const card = doc.getElementById('open-in-line');
  assert.ok(card, '應出現用 LINE 繼續的卡片');
  assert.equal(card.getAttribute('data-mode'), 'desktop');
  assert.equal(doc.getElementById('open-in-line-qr').getAttribute('src'), '/api/games/wheel/share-miles/open-in-line.svg?ref=' + REF);
  assert.equal(card.querySelectorAll('.oil-steps li').length, 3);
  assert.equal(card.querySelector('.oil-title').textContent, '請開啟手機版 LINE 遊玩');
  assert.equal(card.querySelector('.oil-sub').textContent, '掃描 QR Code 前往 LINE');
  assert.deepEqual([...card.querySelectorAll('.oil-steps li span')].map(s => s.textContent), ['開啟手機 LINE', '點搜尋列旁的掃描圖示', '對準 QR Code']);
  assert.match(card.textContent, /複製連結/);
  // 電腦版不顯示遊戲本體：卡片後面的輪盤、狀態列、按鈕、邀請區全部收起
  for (const id of ['status-row', 'cta-spin', 'invite-card']) {
    assert.equal(dom.window.getComputedStyle(doc.getElementById(id)).display, 'none', id + ' 應隱藏');
  }
  assert.equal(dom.window.getComputedStyle(doc.querySelector('.stage-wrap')).display, 'none');
  assert.notEqual(dom.window.getComputedStyle(doc.querySelector('section.hero')).display, 'none', '頁首保留');
  assert.match(card.textContent, /好友邀請資格將自動保留/);
  assert.equal(doc.getElementById('cta-spin').hidden, true);
  assert.equal(doc.getElementById('status-row').hidden, true);
  assert.match(card.querySelector('.oil-kicker').textContent, /LINE 好友限定/);
  // 電腦版：卡片放在頁首介紹正下方（輪盤上面），第一個畫面就看得到 QR Code
  assert.equal(doc.querySelector('section.hero').nextElementSibling.id, 'open-in-line');
  assert.equal(apiCalls.filter(u => /\/api\/games\//.test(String(u))).length, 0);
  dom.window.close();
});

test('手機瀏覽器打開輪盤：顯示「用 LINE 開啟」按鈕，連到活動 LIFF 連結並保留 ref', async () => {
  const { dom, doc } = await openGame('game_wheel', 'wheel', { ua: IPHONE_UA, search: '?ref=' + REF });
  const card = doc.getElementById('open-in-line');
  assert.equal(card.getAttribute('data-mode'), 'mobile');
  assert.equal(doc.getElementById('open-in-line-btn').getAttribute('href'),
    'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles?ref=' + REF);
  assert.equal(doc.getElementById('open-in-line-qr'), null);
  // 手機版維持在狀態列下方
  assert.equal(doc.getElementById('status-row').nextElementSibling.id, 'open-in-line');
  assert.equal(card.querySelector('.oil-title').textContent, '請開啟手機版 LINE 遊玩');
  assert.equal(card.querySelector('.oil-sub').textContent, '點擊下方按鈕前往 LINE');
  assert.equal(doc.getElementById('open-in-line-btn').textContent, '立即前往');
  assert.match(card.textContent, /沒有跳到 LINE？複製連結/);
  assert.equal(doc.getElementById('status-row').hidden, true);
  dom.window.close();
});

test('不合法的 ref 不會被帶進連結', async () => {
  const { dom, doc } = await openGame('game_wheel', 'wheel', { ua: IPHONE_UA, search: '?ref=javascript:alert(1)' });
  assert.equal(doc.getElementById('open-in-line-btn').getAttribute('href'), 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles');
  assert.doesNotMatch(doc.getElementById('open-in-line').textContent, /好友邀請資格/);
  dom.window.close();
});

test('刮刮樂、拉霸、抽籤、領取優惠券頁也都有同一張卡片', async () => {
  for (const [view, gt] of [['game_scratch', 'scratch'], ['game_slot', 'slot'], ['game_fortune', 'fortune'], ['game_claim', 'claim']]) {
    const { dom, doc } = await openGame(view, gt, { ua: DESKTOP_UA });
    const card = doc.getElementById('open-in-line');
    assert.ok(card, view + ' 應出現卡片');
    assert.equal(doc.getElementById('open-in-line-qr').getAttribute('src'), '/api/games/' + gt + '/share-miles/open-in-line.svg');
    const sr = doc.getElementById('status-row');
    if (sr) assert.equal(dom.window.getComputedStyle(sr).display, 'none', view + ' 狀態列要真的藏起來');
    const stage = doc.querySelector('.stage-card');
    if (stage) assert.equal(dom.window.getComputedStyle(stage).display, 'none', view + ' 遊戲區要收起');
    dom.window.close();
  }
});

test('buildOpenInLineUrl：只帶合法 LINE userId 的 ref', () => {
  assert.equal(buildOpenInLineUrl('L-1', 'wheel', 'share-miles', REF), 'https://liff.line.me/L-1/wheel/share-miles?ref=' + REF);
  assert.equal(buildOpenInLineUrl('L-1', 'wheel', 'share-miles', 'https://evil.example'), 'https://liff.line.me/L-1/wheel/share-miles');
  assert.equal(buildOpenInLineUrl('L-1', 'scratch', 'a b', ''), 'https://liff.line.me/L-1/scratch/a%20b');
});

function registerRoutes(rows) {
  const routes = {};
  const app = { get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; } };
  registerGameType(app, { query: async () => ({ rows }), pool: {}, flowEngine: null }, { gameType: 'wheel', viewName: 'game_wheel', defaultLiffId: 'DEFAULT-LIFF' });
  return routes['GET /api/games/wheel/:slug/open-in-line.svg'][0];
}
function res() {
  return {
    statusCode: 200, headers: {},
    status(c) { this.statusCode = c; return this; }, type(t) { this.headers['content-type'] = t; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, send(b) { this.body = b; return this; }
  };
}

test('QR 端點：回 SVG、用活動自己的 LIFF ID，錯的類型或不存在回 404', async () => {
  const handler = registerRoutes([{ slug: 'share-miles', game_type: 'wheel', liff_id_override: 'OVERRIDE-LIFF' }]);
  const ok = res();
  await handler({ params: { slug: 'share-miles' }, query: { ref: REF } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['content-type'], /image\/svg\+xml/);
  assert.match(ok.body, /^<svg/);

  const wrongType = res();
  await registerRoutes([{ slug: 'x', game_type: 'scratch', liff_id_override: null }])({ params: { slug: 'x' }, query: {} }, wrongType);
  assert.equal(wrongType.statusCode, 404);
  const missing = res();
  await registerRoutes([])({ params: { slug: 'nope' }, query: {} }, missing);
  assert.equal(missing.statusCode, 404);
});
