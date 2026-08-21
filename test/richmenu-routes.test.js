// 發布／設預設／刪除的完整情境：順序、回滾、脫鉤防護、實況判斷。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }
const IMG = 'data:image/jpeg;base64,' + Buffer.from('fakejpg').toString('base64');

function build({ uploadFails, dbUpdateFails, liveDefaultId, setDefaultFails } = {}) {
  const lineCalls = [], dbCalls = [];
  global.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    lineCalls.push(method + ' ' + url);
    if (method === 'GET' && /user\/all\/richmenu$/.test(url)) {
      if (!liveDefaultId) return { ok: false, status: 404, text: async () => '{}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: liveDefaultId }) };
    }
    if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-new1' }) };
    if (/\/content$/.test(url)) {
      if (uploadFails) return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'image bad' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (method === 'POST' && /user\/all\/richmenu\//.test(url)) {
      if (setDefaultFails) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    dbCalls.push({ f, params });
    if (/SELECT id, name, config, line_rich_menu_id, is_default FROM rich_menus/.test(f))
      return { rows: [{ id: 1, name: '測試', is_default: false, line_rich_menu_id: 'richmenu-old9',
        config: { size: 'large', chat_bar_text: '選單',
          cells: [{ x: 0, y: 0, w: 2500, h: 1686 }],
          buttons: [{ label: '找餐廳', action: { type: 'uri', uri: 'https://www.openrice.com' } }] } }] };
    if (/SELECT line_rich_menu_id FROM rich_menus WHERE id=/.test(f))
      return { rows: [{ line_rich_menu_id: 'richmenu-old9' }] };
    if (/SELECT line_rich_menu_id, status FROM rich_menus WHERE id=/.test(f))
      return { rows: [{ line_rich_menu_id: 'richmenu-old9', status: 'published' }] };
    if (dbUpdateFails && /SET line_rich_menu_id=\$2/.test(f)) throw new Error('db timeout');
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
  for (let i = 0; i < hs.length; i++) {
    let called = false;
    await hs[i]({ body: reqBody, query: {}, authUser: { un: 'admin', adm: true } }, r, () => { called = true; });
    if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 發布＋勾設預設：建 → 傳圖 → 寫 DB → 設預設 → 刪舊
  let t = build({});
  let r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: true });
  ok(r.body && r.body.ok === true, '發布成功');
  const seq = t.lineCalls.join('\n');
  const iCreate = seq.indexOf('POST https://api.line.me/v2/bot/richmenu');
  const iUpload = seq.indexOf('/content');
  const iDefault = seq.indexOf('POST https://api.line.me/v2/bot/user/all/richmenu/richmenu-new1');
  const iDelOld = seq.indexOf('DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9');
  ok(iCreate >= 0 && iUpload > iCreate && iDefault > iUpload && iDelOld > iDefault, '順序：建→傳圖→設預設→刪舊');
  const dbWriteIdx = t.dbCalls.findIndex(c => /SET line_rich_menu_id=\$2/.test(c.f));
  ok(dbWriteIdx >= 0, 'DB 有寫入新 id');
  ok(t.dbCalls.some(c => /SET is_default = \(id = \$1\)/.test(c.f)), '預設旗標用 id 比對（草稿列不會產生 NULL）');

  // 2) 沒勾設預設、也不是正在看的 → 不碰預設、照樣刪舊
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: false });
  ok(r.body && r.body.ok === true && r.body.is_default === false, '備用發布成功');
  ok(!t.lineCalls.some(c => c.indexOf('POST https://api.line.me/v2/bot/user/all/richmenu/') === 0), '沒動預設');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9'), '舊版清掉');

  // 3) 正在更新的就是所有人看到的（LINE 實況）→ 即使沒勾也強制設預設（不能讓用戶沒選單）
  t = build({ liveDefaultId: 'richmenu-old9' });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: false });
  ok(r.body && r.body.ok === true && r.body.is_default === true, '換掉現役選單時自動接手預設');
  ok(t.lineCalls.some(c => c === 'POST https://api.line.me/v2/bot/user/all/richmenu/richmenu-new1'), '新選單接手');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9'), '接手後才刪舊');

  // 4) 傳圖失敗 → 半成品刪掉、DB 沒動
  t = build({ uploadFails: true });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG });
  ok(r.code === 500, '傳圖失敗回錯誤');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-new1'), '半成品刪掉');
  ok(!t.dbCalls.some(c => /status='published'/.test(c.f)), 'DB 沒動');

  // 5) DB 寫入失敗 → 半成品刪掉、舊選單原封不動、錯誤講人話
  t = build({ dbUpdateFails: true });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG });
  ok(r.code === 500 && r.body.error === 'db_failed', 'DB 失敗回報');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-new1'), '半成品刪掉');
  ok(!t.lineCalls.some(c => c.indexOf('richmenu-old9') >= 0), '舊選單沒被碰');

  // 6) 設預設失敗 → 選單已發布（DB 已記錄）、舊的不刪、錯誤告訴使用者怎麼補救
  t = build({ liveDefaultId: 'richmenu-old9', setDefaultFails: true });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: true });
  ok(r.code === 500 && r.body.error === 'set_default_failed', '設預設失敗回報');
  ok(String(r.body.detail).indexOf('發布成功') >= 0, '錯誤訊息講清楚選單其實發布好了');
  ok(!t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9'), '現役舊選單沒被刪（用戶不會沒選單）');

  // 7) set-default：SQL 用 IS NOT DISTINCT FROM（有草稿也不會爆）
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/set-default', { id: 1 });
  ok(r.body && r.body.ok === true, '設預設成功');
  ok(t.dbCalls.some(c => /IS NOT DISTINCT FROM/.test(c.f)), '旗標更新對草稿列安全');

  // 8) 刪除正在看的選單 → 擋下
  t = build({ liveDefaultId: 'richmenu-old9' });
  r = await run(t.routes, 'POST /admin/richmenu/api/delete', { id: 1 });
  ok(r.code === 400 && r.body.error === 'is_live', '不准刪所有人正在看的選單');
  ok(!t.lineCalls.some(c => c.indexOf('DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9') === 0), 'LINE 上沒被刪');

  // 9) 圖片格式錯／超大 → 400、不碰 LINE
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: 'data:text/html;base64,xxxx' });
  ok(r.code === 400 && t.lineCalls.length === 0, '非圖片擋下且不打 LINE');
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/publish',
    { id: 1, image: 'data:image/jpeg;base64,' + Buffer.alloc(1024 * 1024 + 100, 65).toString('base64') });
  ok(r.code === 400 && r.body.error === 'image_too_big', '超大圖擋下');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n發布流程全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
