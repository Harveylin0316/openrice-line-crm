// 「檢查這個連結」：關鍵是分得出「打不開」「被導回首頁」「真的可以用」。
// 打錯路徑的網站多半不回 404，而是默默導回首頁——這種最危險，看起來一切正常。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function build(fetchImpl) {
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  global.fetch = fetchImpl;
  const taps = [];
  const query = async (sql, params) => {
    if (/INSERT INTO message_taps/.test(String(sql))) { taps.push(params); return { rows: [] }; }
    return { rows: [] };
  };
  const pass = (rq, rs, nx) => nx();
  registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, taps };
}
function mkRes() { const o = { code: 200, body: null, redirected: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.redirect = u => { o.redirected = u; return o; }; o.render = () => o; return o; }
async function run(routes, key, body, extras) {
  const hs = routes[key]; const r = mkRes();
  const req = { body: body || {}, query: {}, params: {}, headers: {}, authUser: { un: 'a', adm: true },
                get: () => '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false; await hs[i](req, r, () => { called = true; }); if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 打錯路徑被導回首頁（就是「下載App」踩到的情況）
  let t = build(async () => ({ ok: true, status: 200, url: 'https://tw.openrice.com/zh-tw/taipei' }));
  let r = await run(t.routes, 'POST /admin/richmenu/api/check-link',
    { url: 'https://www.openrice.com/download-app' });
  ok(r.body.verdict === 'suspect', '打錯路徑被導回首頁 → 標成「要注意」（不是綠燈）');
  ok(/導回首頁/.test(r.body.note) && /不會看到你要的內容/.test(r.body.note),
     '而且講清楚後果：' + r.body.note.slice(0, 30) + '…');

  // 2) 真的可以用（就是「立即訂位」的情況：有轉一次但落在正確的頁面）
  t = build(async () => ({ ok: true, status: 200,
    url: 'https://tw.openrice.com/zh-tw/taipei/restaurants?regionId=704&tmReservation=true' }));
  r = await run(t.routes, 'POST /admin/richmenu/api/check-link',
    { url: 'https://s.openrice.com/cHRKm02000000ZbYA' });
  ok(r.body.verdict === 'ok', '短網址轉到正確頁面 → 綠燈');

  // 3) 真的打不開
  t = build(async () => ({ ok: false, status: 404, url: 'https://x.com/nope' }));
  r = await run(t.routes, 'POST /admin/richmenu/api/check-link', { url: 'https://x.com/nope' });
  ok(r.body.verdict === 'bad' && /打不開/.test(r.body.note), '404 → 標成有問題');

  // 4) 網站沒回應也不能讓後台卡住
  t = build(async () => { const e = new Error('The operation was aborted'); throw e; });
  r = await run(t.routes, 'POST /admin/richmenu/api/check-link', { url: 'https://slow.example.com' });
  ok(r.body.verdict === 'bad' && /沒有回應/.test(r.body.note), '網站沒回應時講人話，不是丟錯誤代碼');

  // 5) 亂填的東西擋掉
  t = build(async () => ({ ok: true, status: 200, url: 'x' }));
  r = await run(t.routes, 'POST /admin/richmenu/api/check-link', { url: '不是網址' });
  ok(r.code === 400 && /https/.test(r.body.detail), '亂填的擋下來並說明格式');

  // 6) 說明裡不能有術語
  const allNotes = [r.body.detail];
  t = build(async () => ({ ok: true, status: 200, url: 'https://tw.openrice.com/zh-tw/taipei' }));
  r = await run(t.routes, 'POST /admin/richmenu/api/check-link', { url: 'https://www.openrice.com/download-app' });
  allNotes.push(r.body.note);
  ok(!allNotes.some(n => /HTTP|redirect|status|URL|API/i.test(String(n).replace('https', ''))),
     '所有說明都是人話，沒有工程術語');

  // 7) App 下載會自動分辨手機系統
  t = build(async () => ({ ok: true, status: 200, url: 'x' }));
  r = await run(t.routes, 'GET /go/app', null,
    { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
  ok(/apps\.apple\.com/.test(r.redirected), 'iPhone → 跳 App Store');
  t = build(async () => ({ ok: true, status: 200, url: 'x' }));
  r = await run(t.routes, 'GET /go/app', null,
    { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' } });
  ok(/play\.google\.com/.test(r.redirected), 'Android → 跳 Google Play');
  ok(t.taps.length === 1 && t.taps[0][0] === 'android' && /play\.google/.test(t.taps[0][1]),
     '順便記一筆「有人要下載 App」（含是哪個系統）');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n連結檢查與 App 下載都正確');
  process.exit(failed ? 1 : 0);
})();
