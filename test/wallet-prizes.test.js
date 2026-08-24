// 「我的獎品」頁：哩數等沒有序號的獎也要看得到。
const path = require('path');
const REPO = path.join(__dirname, '..');
const ejs = require(path.join(REPO, 'node_modules/ejs'));
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.log('SKIP：需要 jsdom（npm i -D jsdom）'); process.exit(0); }

let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

async function boot(payload) {
  const html = await ejs.renderFile(path.join(REPO, 'views/game_wallet.ejs'),
    { title: 'x', liffId: 'a-b', bodyClass: '', addFriendUrl: '' }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, { runScripts: 'dangerously',
    url: 'https://x/games/wallet?uid=U' + 'a'.repeat(32) + '&name=T',
    beforeParse(w) {
      w.fetch = () => Promise.resolve({ json: async () => payload });
      w.liff = { init: async () => {}, isInClient: () => true, isLoggedIn: () => true,
                 getProfile: async () => ({ userId: 'U' + 'a'.repeat(32) }), getIDToken: () => 't' };
    } });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 300));
  return dom.window.document;
}

(async () => {
  // 1) 哩數獎品（沒有序號）要出現，狀態講人話
  let doc = await boot({ ok: true, coupons: [],
    prizes: [{ activity_name: '分享超有哩', activity_slug: 'share-miles', prize_name: '26,000 哩',
               is_win: true, miles: 26000, code: null, won_at: '2026-08-21T03:00:00Z', redeemed: false },
             { activity_name: '分享超有哩', activity_slug: 'share-miles', prize_name: '銘謝惠顧',
               is_win: false, miles: null, code: null, won_at: '2026-08-21T02:00:00Z', redeemed: false }] });
  let txt = doc.body.textContent.replace(/\s+/g, ' ');
  ok(txt.indexOf('26,000 哩') >= 0, '哩數獎品有出現');
  ok(txt.indexOf('活動結束後統一發放') >= 0, '發放狀態講人話');
  ok(txt.indexOf('銘謝惠顧') < 0, '沒中獎的那次不會出現在獎品頁');

  // 2) 什麼都沒有 → 空狀態
  doc = await boot({ ok: true, coupons: [], prizes: [] });
  txt = doc.body.textContent.replace(/\s+/g, ' ');
  ok(txt.indexOf('你還沒有獎品') >= 0, '空狀態文案正確');

  // 3) 券與哩數同時存在 → 兩種都列
  doc = await boot({ ok: true,
    coupons: [{ activity_name: '旅電', prize_name: '借電券', code: 'LD-1', won_at: '2026-08-20T01:00:00Z',
                redeemed: false, redeem_url: null, use_expires_on: null }],
    prizes: [{ activity_name: '分享超有哩', prize_name: '5,000 哩', is_win: true, miles: 5000,
               code: null, won_at: '2026-08-21T01:00:00Z', redeemed: true }] });
  txt = doc.body.textContent.replace(/\s+/g, ' ');
  ok(txt.indexOf('5,000 哩') >= 0 && txt.indexOf('LD-1') >= 0, '哩數與優惠券同時列出');
  ok(txt.indexOf('哩數已經發放') >= 0, '已發放的哩數講清楚');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n我的獎品頁全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
