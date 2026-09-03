// 後台權限即時檢查：測的是「正本」（src/core/adminLiveness.js），不是抄一份副本。
// 資料庫查不到時的分層：重試 → 用 60 秒內驗過的 → 讀的放行、寫的擋（但絕不清登入）
const path = require('path');
const { createAdminLiveness } = require(path.join(__dirname, '..', 'src/core/adminLiveness'));
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function build(queryImpl) {
  const cleared = [];
  const authCore = { clearAuthCookie: () => cleared.push(1) };
  return { mw: createAdminLiveness({ query: queryImpl, authCore }), cleared };
}
function mkRes() {
  const o = { code: 200, body: null, html: null, locals: {}, headers: {}, ctype: null };
  o.status = c => { o.code = c; return o; };
  o.json = b => { o.body = b; return o; };
  o.set = (k, v) => { o.headers[k] = v; return o; };
  o.type = t => { o.ctype = t; return o; };
  o.send = h => { o.html = h; return o; };
  return o;
}
async function run(mw, req) {
  const res = mkRes(); let nexted = false;
  req.get = req.get || (h => (req.headers || {})[String(h).toLowerCase()] || '');
  await mw(req, res, () => { nexted = true; });
  return { res, nexted, req };
}
const USER = () => ({ uid: 7, un: 'hen', adm: true, role: 'admin', se: 3 });
const OKROW = { rows: [{ is_admin: true, role: 'admin', is_active: true, sess_epoch: 3 }] };

(async () => {
  // 正常
  let t = build(async () => OKROW);
  let r = await run(t.mw, { path: '/admin/richmenu', method: 'GET', headers: {}, authUser: USER() });
  ok(r.nexted && r.req.authUser.adm === true, '正常情況照樣放行');

  // 被停用／改過密碼 → 立刻登出（這才是該清登入的時候）
  t = build(async () => ({ rows: [{ is_admin: true, role: 'admin', is_active: false, sess_epoch: 3 }] }));
  r = await run(t.mw, { path: '/admin/x', method: 'GET', headers: {}, authUser: USER() });
  ok(r.req.authUser === null && t.cleared.length === 1, '帳號被停用 → 立刻登出');

  t = build(async () => ({ rows: [{ is_admin: true, role: 'admin', is_active: true, sess_epoch: 9 }] }));
  r = await run(t.mw, { path: '/admin/x', method: 'GET', headers: {}, authUser: USER() });
  ok(r.req.authUser === null, '別的裝置改過密碼 → 舊登入立刻失效');

  // 抖動一次 → 自動重試
  let n = 0;
  t = build(async () => { n++; if (n === 1) throw new Error('逾時'); return OKROW; });
  r = await run(t.mw, { path: '/admin/x', method: 'GET', headers: {}, authUser: USER() });
  ok(r.nexted && n === 2 && r.req.authUser.adm === true, '抖動一次會自動重試，使用者無感');

  // 剛驗過就連不上 → 沿用，不打斷工作
  let live = true;
  t = build(async () => { if (!live) throw new Error('掛了'); return OKROW; });
  await run(t.mw, { path: '/admin/x', method: 'GET', headers: {}, authUser: USER() });
  live = false;
  r = await run(t.mw, { path: '/admin/api/save', method: 'POST', headers: {}, authUser: USER() });
  ok(r.nexted && r.res.code === 200, '剛驗過就連不上：照樣讓他把工作做完');

  // 連不上又沒驗過：GET 放行但降級，而且角色降到最低
  t = build(async () => { throw new Error('掛了'); });
  r = await run(t.mw, { path: '/admin/accounts', method: 'GET', headers: {}, authUser: USER() });
  ok(r.nexted && r.res.locals.authDegraded === true, '連不上又沒驗過：看得到畫面，但標記降級');
  ok(r.req.authUser.role === 'staff', '降級期間不沿用舊角色（被降級的人不能用舊身分逛管理頁）');
  ok(t.cleared.length === 0, '這種情況「絕對不清登入」——問不到不等於這個人無效');

  // 連不上又沒驗過：寫入被擋，但登入要留著
  t = build(async () => { throw new Error('掛了'); });
  r = await run(t.mw, { path: '/admin/richmenu/api/publish', method: 'POST',
                        headers: { accept: 'application/json' }, authUser: USER() });
  ok(!r.nexted && r.res.code === 503, '寫入動作被擋下來');
  ok(t.cleared.length === 0, '擋下來的同時沒有把人登出（登入本身也要查資料庫，登出就回不來了）');
  ok(r.res.headers['Retry-After'] === '10', '有告訴瀏覽器等十秒再試');
  ok(/沒有執行/.test(r.res.body.detail) && /不用重新登入/.test(r.res.body.detail),
     '訊息講明「沒有執行」而且「不用重新登入」');
  ok(!/token|session|cookie|API|JSON/i.test(r.res.body.detail), '訊息裡沒有工程術語');

  // 傳統表單送出 → 回看得懂的頁面，不是一串程式碼
  t = build(async () => { throw new Error('掛了'); });
  r = await run(t.mw, { path: '/admin/prizes', method: 'POST',
                        headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
                        authUser: USER() });
  ok(r.res.code === 503 && r.res.ctype === 'html' && !r.res.body, '表單送出時回網頁，不是回一串程式碼');
  ok(/系統忙線中/.test(r.res.html) && /回上一頁/.test(r.res.html), '頁面上有白話說明與「回上一頁」');
  ok(!/\{|\}|ok:|error:/.test(r.res.html.replace(/<[^>]*>/g, '')), '畫面上看不到大括號那種東西');

  // 前台不受影響
  t = build(async () => { throw new Error('掛了'); });
  r = await run(t.mw, { path: '/games/wheel/share-miles', method: 'GET', headers: {}, authUser: USER() });
  ok(r.nexted && !r.res.locals.authDegraded, '前台頁面不受這個檢查影響');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n權限檢查的分層處理全部通過（測的是正本）');
  process.exit(failed ? 1 : 0);
})();
