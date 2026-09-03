// LIFF 的網址是「liff.line.me/<編號>/<路徑>」，那個 <路徑> 會被接在該 LIFF
// 設定的網頁位置後面。本專案的 LIFF 設在 /games 底下，所以組出來的路徑
// 一定要在伺服器上有 /games/<路徑> 的路由，否則使用者會看到「Cannot GET」。
// （這支測試就是為了那次線上事故：記名跳板組了 /t/... 但伺服器只有根目錄那條。）
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
process.env.URL = 'https://example.netlify.app';
process.env.GAMES_LIFF_ID = 'LIFFID';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 收集這支路由註冊了哪些路徑
const registered = { GET: [], POST: [] };
const app = {
  get: (p, ...h) => { registered.GET.push(p); },
  post: (p, ...h) => { registered.POST.push(p); },
  delete: () => {}, put: () => {}
};
global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
const pass = (rq, rs, nx) => nx();
registerAdminRichMenuRoutes(app, { query: async () => ({ rows: [] }),
  authCore: { requireAdmin: pass, requireOwner: pass } });

// 把路由樣板（含 :參數 與 regex）變成可比對的形狀
function toShape(p) {
  return String(p).replace(/:[A-Za-z_]+(\([^)]*\))?/g, '*').replace(/\/+$/, '');
}
const getShapes = registered.GET.map(toShape);
const postShapes = registered.POST.map(toShape);

// 發布時會組出來的 LIFF 網址路徑（跟 withTrackingLinks／關鍵字回覆用的組法一致）
const liffPaths = [
  { path: '/t/3/1/2',            用途: '選單按鍵的記名跳板' },
  { path: '/t/m/keyword/1_0',    用途: '訊息按鈕的記名跳板' }
];

for (const lp of liffPaths) {
  const shape = toShape(lp.path.replace(/\/\d+/g, '/*').replace(/\/[A-Za-z0-9_-]+_\d+$/, '/*'));
  // LIFF 進來時實際會打到 /games 底下
  const viaLiff = '/games' + lp.path;
  const hit = getShapes.some(s => {
    const re = new RegExp('^' + s.replace(/\*/g, '[^/]+') + '$');
    return re.test(viaLiff);
  });
  ok(hit, lp.用途 + '：從 LINE 進來的路徑（' + viaLiff + '）伺服器接得住');
  const hitDirect = getShapes.some(s => {
    const re = new RegExp('^' + s.replace(/\*/g, '[^/]+') + '$');
    return re.test(lp.path);
  });
  ok(hitDirect, lp.用途 + '：直接貼網址測試（' + lp.path + '）也接得住');
}

// 回報端點同樣要兩邊都有
for (const p of ['/games/t/3/1/2/hit', '/t/3/1/2/hit',
                 '/games/t/m/keyword/1_0/hit', '/t/m/keyword/1_0/hit']) {
  const hit = postShapes.some(s => new RegExp('^' + s.replace(/\*/g, '[^/]+') + '$').test(p));
  ok(hit, '回報端點接得住 ' + p);
}

// 檢查程式裡組 LIFF 網址的地方，路徑有沒有對應的 /games 路由
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/adminRichMenu.js'), 'utf8');
const built = [...src.matchAll(/liff\.line\.me\/'\s*\+\s*\w+\s*\+\s*'([^']+)'/g)].map(m => m[1]);
ok(built.length > 0, '找得到程式裡組 LIFF 網址的地方（' + built.length + ' 處）');
for (const b of built) {
  const sample = '/games' + b.replace(/\/$/, '') + '/1/0/0';
  const loose = getShapes.some(s => s.indexOf('/games' + b.split('/').slice(0, 2).join('/')) === 0);
  ok(loose, '組出來的路徑「' + b + '」在 /games 底下有對應的路由');
}

console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\nLIFF 網址與伺服器路由對得起來');
process.exit(failed ? 1 : 0);
