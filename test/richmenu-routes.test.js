// 發布流程：建選單 → 傳圖 →（設預設）→ 刪舊的，順序與失敗回滾都要對。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }
const IMG = 'data:image/jpeg;base64,' + Buffer.from('fakejpg').toString('base64');

function build({ uploadFails } = {}) {
  const lineCalls = [], dbCalls = [];
  global.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    lineCalls.push(method + ' ' + url);
    if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-new1' }) };
    if (/\/content$/.test(url)) {
      if (uploadFails) return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'image bad' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; },
                delete: () => {}, put: () => {} };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    dbCalls.push({ f, params });
    if (/SELECT id, name, config, line_rich_menu_id, is_default FROM rich_menus/.test(f))
      return { rows: [{ id: 1, name: '測試', is_default: false, line_rich_menu_id: 'richmenu-old9',
        config: { size: 'large', chat_bar_text: '選單',
          cells: [{ x: 0, y: 0, w: 2500, h: 1686 }],
          buttons: [{ label: '找餐廳', action: { type: 'uri', uri: 'https://www.openrice.com' } }] } }] };
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, lineCalls, dbCalls };
}
function res() { const o = { code: 200, body: null }; o.status = c => { o.code = c; return o; };
  o.json = b => { o.body = b; return o; }; o.render = () => o; o.redirect = () => o; return o; }
async function run(routes, key, reqBody) {
  const hs = routes[key]; const r = res();
  // 逐個跑 middleware（requireAdmin 是 pass-through）
  for (let i = 0; i < hs.length; i++) {
    let called = false;
    await hs[i]({ body: reqBody, query: {}, authUser: { un: 'admin', adm: true } }, r, () => { called = true; });
    if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 正常發布 + 設預設：順序 = 建 → 傳圖 → 設預設 → 刪舊
  let t = build({});
  let r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: true });
  ok(r.body && r.body.ok === true, '發布成功');
  const seq = t.lineCalls.join('\n');
  const iCreate = seq.indexOf('POST https://api.line.me/v2/bot/richmenu');
  const iUpload = seq.indexOf('/content');
  const iDefault = seq.indexOf('POST https://api.line.me/v2/bot/user/all/richmenu/richmenu-new1');
  const iDelOld = seq.indexOf('DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9');
  ok(iCreate >= 0 && iUpload > iCreate, '先建選單再傳圖');
  ok(iDefault > iUpload, '傳完圖才設預設');
  ok(iDelOld > iDefault, '設完預設才刪舊選單（順序反了用戶會閃沒選單）');
  ok(t.dbCalls.some(c => /SET line_rich_menu_id=\$2, status='published'/.test(c.f)), 'DB 記下新的 id');

  // 2) 傳圖失敗 → 剛建的要刪掉、不能寫 DB
  t = build({ uploadFails: true });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG });
  ok(r.code === 500 && r.body && !r.body.ok, '傳圖失敗回錯誤');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-new1'), '半成品選單有刪掉');
  ok(!t.lineCalls.some(c => c.indexOf('richmenu-old9') >= 0), '舊選單原封不動');
  ok(!t.dbCalls.some(c => /status='published'/.test(c.f)), 'DB 沒被改成已發布');

  // 3) 圖片格式錯 → 400、完全不碰 LINE
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: 'data:text/html;base64,xxxx' });
  ok(r.code === 400 && r.body.error === 'bad_image', '非圖片擋下');
  ok(t.lineCalls.length === 0, '沒打任何 LINE API');

  // 4) 超過 1MB → 400
  t = build({});
  const bigImg = 'data:image/jpeg;base64,' + Buffer.alloc(1024 * 1024 + 100, 65).toString('base64');
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: bigImg });
  ok(r.code === 400 && r.body.error === 'image_too_big', '超大圖擋下');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n發布流程全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
