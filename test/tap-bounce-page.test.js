// 記名跳板頁本身：拿身分 → 回報 → 跳走。
// 三個硬要求：(1) 一定要把人送到目的地 (2) 拿不到身分也要送 (3) 慢也要送（保底）
const path = require('path');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom 沒裝'); process.exit(0); }
const ejs = require('ejs');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const TARGET = 'https://example.com/promo';
const UID = 'U' + 'a'.repeat(32);

async function render() {
  return ejs.renderFile(path.join(REPO, 'views/tap_bounce.ejs'),
    { target: TARGET, liffId: 'LIFFID', recordUrl: '/games/t/3/1/2/hit' });
}

// 用假的 LIFF SDK 跑跳板頁，回傳「回報了什麼」與「跳去哪」
async function runBounce(opts) {
  const html = await render();
  const beacons = [], fetches = [];
  let replaced = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x/games/t/3/1/2',
    beforeParse(w) {
      w.navigator.sendBeacon = (url, body) => { beacons.push({ url, raw: body }); return true; };
      w.fetch = async (url, o) => { fetches.push({ url, body: o && o.body }); return { ok: true }; };
      // 攔住跳轉那一步（jsdom 不做真的導航）
      w.__bounceGo = (u) => { replaced = u; };
      w.liff = opts.liff;
    }});
  const w = dom.window;
  // 頁面自己會定義 __bounceGo，等它定義完再換成我們的攔截版
  const patch = () => { w.__bounceGo = (u) => { replaced = u; }; };
  patch();
  await new Promise(r => w.addEventListener('load', r));
  patch();
  await new Promise(r => setTimeout(r, opts.waitMs || 300));
  // sendBeacon 送的是 Blob，要讀出裡面的文字才看得到內容
  for (const b of beacons) {
    try { b.body = b.raw && typeof b.raw.text === 'function' ? await b.raw.text() : String(b.raw); }
    catch (e) { b.body = String(b.raw); }
  }
  return { beacons, fetches, replaced, doc: w.document, w };
}

(async () => {
  // 1) 正常：拿到身分 → 回報 → 跳走
  let r = await runBounce({ liff: {
    init: async () => {}, isInClient: () => true, isLoggedIn: () => true,
    getProfile: async () => ({ userId: UID })
  }});
  ok(r.replaced === TARGET, '正常情況把人送到目的地');
  const sent = r.beacons[0] || r.fetches[0];
  ok(!!sent, '有回報一筆');
  ok(sent && /U[0-9a-f]{32}/i.test(String(sent.body)), '回報內容帶著是誰按的');

  // 2) 不在 LINE 裡（例如網址被轉貼到瀏覽器）→ 記不到人，但照樣要送過去
  r = await runBounce({ liff: {
    init: async () => {}, isInClient: () => false, isLoggedIn: () => false,
    getProfile: async () => ({ userId: UID })
  }});
  ok(r.replaced === TARGET, '不在 LINE 裡也照樣把人送到目的地');
  const b2 = r.beacons[0] || r.fetches[0];
  ok(b2 && /null/.test(String(b2.body)), '這種情況記成「不知道是誰」，不會亂記');

  // 3) LIFF 整個壞掉 → 還是要送
  r = await runBounce({ liff: { init: async () => { throw new Error('LIFF 掛了'); } } });
  ok(r.replaced === TARGET, 'LIFF 出錯也照樣把人送到目的地');

  // 4) 沒有 LIFF（SDK 沒載到）→ 立刻送
  r = await runBounce({ liff: undefined });
  ok(r.replaced === TARGET, 'LIFF 完全沒載到也照樣送');

  // 5) 拿身分拿很久 → 保底時間到就送人，不能把人卡在白畫面
  r = await runBounce({ waitMs: 2200, liff: {
    init: async () => {}, isInClient: () => true, isLoggedIn: () => true,
    getProfile: () => new Promise(() => {})   // 永遠不回
  }});
  ok(r.replaced === TARGET, '拿身分卡住時，保底時間到照樣把人送走');

  // 6) 真的很慢時畫面上要有東西可以按，不是一片空白
  const manual = r.doc.getElementById('manual');
  ok(manual && manual.getAttribute('href') === TARGET, '畫面上有一個可以自己點的連結');

  // 7) 頁面上不能出現術語
  const vis = r.doc.body.cloneNode(true);
  [].slice.call(vis.querySelectorAll('script,style')).forEach(n => n.remove());
  ok(!/LIFF|API|token|error/i.test(vis.textContent), '畫面上沒有工程術語');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n記名跳板頁的流程全部正確');
  process.exit(failed ? 1 : 0);
})();
