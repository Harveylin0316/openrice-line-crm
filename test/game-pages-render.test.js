// 每一個遊戲頁都要「真的能渲染出來」。
// EJS 的語法檢查（compile）只看得出語法錯誤，看不出執行期的問題——
// 這次就是預設值寫成自己引用自己（Cannot access 'TXT' before initialization），
// compile 完全通過，一上線整頁 500。所以要真的 render 一次。
const path = require('path');
const ejs = require('ejs');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const ACTIVITY = {
  id: 7, slug: 'test-x', name: '測試活動', description: '說明',
  status: 'active', start_at: null, end_at: null, cover_image_url: null,
  daily_plays_per_user: null, require_follow_oa: true, base_plays_per_user: 1,
  referral_bonus_per: 1, referral_bonus_max: 8, referral_invites_per_bonus: 1
};
const PRIZE = (pv) => [{
  id: 1, name: '獎品', description: '', image_url: null, probability_weight: 1,
  stock_total: null, stock_remaining: null, prize_type: 'coupon_code',
  prize_value: pv || {}, position: 0, is_grand_prize: false
}];

const PAGES = [
  { view: 'game_claim',   gameType: 'claim',   name: '領券頁' },
  { view: 'game_wheel',   gameType: 'wheel',   name: '轉盤' },
  { view: 'game_scratch', gameType: 'scratch', name: '刮刮樂' },
  { view: 'game_slot',    gameType: 'slot',    name: '拉霸' },
  { view: 'game_fortune', gameType: 'fortune', name: '抽籤詩' },
  { view: 'game_wallet',  gameType: null,      name: '我的獎品' }
];

// 領券頁的真實設定（含所有文案欄位都有值）與空設定，兩種都要能渲染
const REAL_PV = {
  page_title: '1 小時免費借電券', claimed_title: '你的借電券已準備好',
  tagline: '手機有電，美食不斷線', hero_image: '/images/x.jpg',
  how_to_claim: ['一', '二'], campaign_desc: ['三'], how_to_use: ['四'], tnc: ['五'],
  redeem_url: 'https://x.com', use_expires_on: '2026-12-31', partner: '旅電科技',
  ribbon_before: '自訂標籤', btn_claim: '自訂領取', oos_text: '發完了<br>下次請早'
};

(async () => {
  for (const p of PAGES) {
    for (const [label, pv] of [['沒有任何設定', {}], ['完整設定', REAL_PV]]) {
      try {
        const html = await ejs.renderFile(path.join(REPO, 'views', p.view + '.ejs'), {
          title: '測試', bodyClass: 'liff-shell', activity: ACTIVITY, prizes: PRIZE(pv),
          liffId: 'LIFFID', gameType: p.gameType, addFriendUrl: 'https://line.me/x',
          quota: null, user: '', isAdmin: false
        }, { views: [path.join(REPO, 'views')] });
        ok(html.length > 500, p.name + '（' + label + '）渲染得出來');
      } catch (e) {
        ok(false, p.name + '（' + label + '）渲染失敗：' + String(e.message).split('\n').slice(-1)[0]);
      }
    }
  }

  // 領券頁特別檢查：自訂的字要真的出現，沒設定的要用預設
  const custom = await ejs.renderFile(path.join(REPO, 'views/game_claim.ejs'), {
    title: 'x', bodyClass: '', activity: ACTIVITY, prizes: PRIZE(REAL_PV),
    liffId: 'L', gameType: 'claim', addFriendUrl: ''
  }, { views: [path.join(REPO, 'views')] });
  ok(/自訂標籤/.test(custom) && /自訂領取/.test(custom), '後台設定的文案真的印出來');
  ok(/優惠序號/.test(custom), '沒設定的欄位用預設值');
  ok(/發完了<br>下次請早/.test(custom), '發完的說明可以換行（不會被轉成純文字）');

  const plain = await ejs.renderFile(path.join(REPO, 'views/game_claim.ejs'), {
    title: 'x', bodyClass: '', activity: ACTIVITY, prizes: PRIZE({}),
    liffId: 'L', gameType: 'claim', addFriendUrl: ''
  }, { views: [path.join(REPO, 'views')] });
  ok(/LINE 好友限定/.test(plain) && /領取借電券/.test(plain), '完全沒設定時，預設文案照樣完整');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n所有遊戲頁都渲染得出來');
  process.exit(failed ? 1 : 0);
})();
