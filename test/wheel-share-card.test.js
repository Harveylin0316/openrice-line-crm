const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const USER_ID = 'U' + 'a'.repeat(32);
const COVER_URL = 'https://openrice-line-crm.netlify.app/p/line-media/test-cover';

function fakeCtx() {
  const noop = () => {};
  return {
    canvas: { width: 720, height: 720 }, clearRect: noop, beginPath: noop, moveTo: noop,
    closePath: noop, fill: noop, stroke: noop, arc: noop, lineTo: noop, save: noop,
    restore: noop, translate: noop, rotate: noop, fillText: noop,
    measureText: (t) => ({ width: String(t).length * 11 }), setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    globalAlpha: 1, lineJoin: '', lineCap: '', set font(_v) {}, get font() { return ''; }
  };
}

async function boot({ rejectFlex = false } = {}) {
  const activity = {
    id: 6, slug: 'share-miles', name: '分享超有哩',
    description: '首次開啟 OpenRice 輪盤即享 1 次抽獎；推薦好友加入，最多再抽 3 次！',
    cover_image_url: COVER_URL, game_type: 'wheel', status: 'active',
    base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3,
    referral_invites_per_bonus: 1, start_at: null, end_at: null, rules: {}
  };
  const prizes = [
    {
      id: 1, name: '銘謝惠顧', position: 1, probability_weight: 1,
      is_grand_prize: false, prize_type: 'none', description: '', image_url: null
    },
    {
      id: 2, name: 'Rice Dollar $30', position: 2, probability_weight: 1,
      is_grand_prize: false, prize_type: 'badge', description: '', image_url: null
    }
  ];
  const html = await ejs.renderFile(path.join(REPO, 'views/game_wheel.ejs'), {
    title: '分享超有哩', activity, prizes,
    liffId: '2007974193-3AWiL11Y', effectiveLiffId: '2007974193-3AWiL11Y',
    addFriendUrl: '', shareUrl: '', bodyClass: '', oaAddUrl: ''
  }, { views: [path.join(REPO, 'views')] });

  const shared = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://openrice-line-crm.netlify.app/games/wheel/share-miles',
    beforeParse(w) {
      w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      w.liff = {
        init: async () => {}, isLoggedIn: () => true, isInClient: () => true,
        isApiAvailable: (name) => name === 'shareTargetPicker', getIDToken: () => 'token',
        login() {}, getProfile: async () => ({ userId: USER_ID, displayName: 'Ice' }),
        shareTargetPicker: async (messages) => {
          shared.push(messages);
          if (rejectFlex && messages[0] && messages[0].type === 'flex') throw new Error('unsupported flex');
          return { status: 'success' };
        }
      };
      w.fetch = (url) => {
        if (String(url).includes('/meta')) return Promise.resolve({ json: async () => ({
          ok: true,
          quota: {
            total: 1, played: 0, remaining: 1, referrals: 0, referrals_existing: 0,
            base: 1, referral_bonus: 0, referral_bonus_max: 3, referral_bonus_per: 1,
            referral_invites_per_bonus: 1, next_bonus_in: 1, bonus_plays: 0, override: null
          }
        }) });
        if (String(url).includes('/wallet')) return Promise.resolve({ json: async () => ({ ok: true, coupons: [], prizes: [] }) });
        return Promise.resolve({ json: async () => ({ ok: true }) });
      };
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  dom.window.document.getElementById('invite-btn').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { dom, shared };
}

test('邀請好友會送出含活動封面、說明與 CTA 的 LINE Flex 卡片', async () => {
  const { dom, shared } = await boot();
  try {
    assert.equal(shared.length, 1);
    const message = shared[0][0];
    const expectedUrl = 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles?ref=' + USER_ID;
    assert.equal(message.type, 'flex');
    assert.match(message.altText, /分享超有哩/);
    assert.equal(message.contents.type, 'bubble');
    assert.equal(message.contents.hero.url, COVER_URL);
    assert.equal(message.contents.hero.action.type, 'uri');
    assert.equal(message.contents.hero.action.uri, expectedUrl);
    assert.equal(message.contents.body.contents[0].text, '分享超有哩');
    assert.match(message.contents.body.contents[1].text, /最多再抽 3 次/);
    const button = message.contents.footer.contents[0];
    assert.equal(button.action.label, '馬上玩');
    assert.equal(button.action.type, 'uri');
    assert.equal(button.action.uri, expectedUrl);
  } finally {
    dom.window.close();
  }
});

test('客戶端不支援 Flex 時會退回文字邀請，ref 仍完整保留', async () => {
  const { dom, shared } = await boot({ rejectFlex: true });
  try {
    assert.equal(shared.length, 2);
    assert.equal(shared[0][0].type, 'flex');
    assert.equal(shared[1][0].type, 'text');
    assert.match(shared[1][0].text, /分享超有哩/);
    assert.match(shared[1][0].text, new RegExp('\\?ref=' + USER_ID + '$'));
  } finally {
    dom.window.close();
  }
});
