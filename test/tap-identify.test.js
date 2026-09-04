// 「記錄是誰點的」：勾了的按鍵走 LIFF 跳板，跳板記得到人；沒勾的維持原本的快速轉址。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));
const { sanitizeMenuConfig } = require(path.join(__dirname, '..', 'src/core/lineRichMenu'));
const { isOwnLiff: isOwnLiffFn } = require(path.join(__dirname, '..', 'src/core/messageTapTracking'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
process.env.URL = 'https://example.netlify.app';
process.env.GAMES_LIFF_ID = '1234-abcd';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const CFG = { size: 'large', chat_bar_text: '選單',
  cells: [{ x: 0, y: 0, w: 1250, h: 1686 }, { x: 1250, y: 0, w: 1250, h: 1686 }],
  buttons: [
    { label: '找餐廳', identify: true,  action: { type: 'uri', uri: 'https://www.openrice.com/tw' } },
    { label: '看菜單', identify: false, action: { type: 'uri', uri: 'https://www.openrice.com/menu' } }
  ] };

function build(opts) {
  opts = opts || {};
  const routes = {}, taps = [], lineCalls = [];
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  global.fetch = async (url, o) => {
    lineCalls.push(((o && o.method) || 'GET') + ' ' + url);
    if (/user\/all\/richmenu$/.test(url) && (!o || o.method === 'GET'))
      return { ok: false, status: 404, text: async () => '{}' };
    if (/\/v2\/bot\/richmenu$/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-n1' }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const dbCalls = [];
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    dbCalls.push({ f, params });
    if (/INSERT INTO rich_menu_taps/.test(f)) { taps.push(params); return { rows: [] }; }
    if (/SELECT published_config FROM rich_menus/.test(f))
      return { rows: [{ published_config: opts.published || CFG }] };
    if (/SELECT id, name, config, line_rich_menu_id/.test(f))
      return { rows: [{ id: 1, name: '主選單', config: CFG, line_rich_menu_id: null,
        line_rich_menu_ids: null, is_default: false, audience_list_id: null,
        published_config: null, status: 'draft', published_at: null, audience_applied_at: null }] };
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, taps, dbCalls, lineCalls };
}
function res() { const o = { code: 200, body: null, redirected: null, rendered: null, locals: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.redirect = u => { o.redirected = u; return o; };
  o.render = (v, d) => { o.rendered = v; o.locals = d; return o; }; return o; }
async function run(routes, key, body, extras) {
  const hs = routes[key]; if (!hs) throw new Error('沒有這個路由：' + key);
  const r = res();
  const req = { body: body || {}, query: {}, params: {}, headers: {}, ip: '1.1.1.1',
                authUser: { un: 'admin', adm: true }, get: () => '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false; await hs[i](req, r, () => { called = true; }); if (!called) break;
  }
  return r;
}
const UID = 'U' + 'a'.repeat(32);

(async () => {
  // 1) 設定存得住：只有「開啟網址」的按鍵留得住這個勾選
  const clean = sanitizeMenuConfig({ ...CFG, buttons: [
    { label: 'a', identify: true, action: { type: 'uri', uri: 'https://x.com' } },
    { label: 'b', identify: true, action: { type: 'message', text: '哈囉' } } ] });
  ok(clean.buttons[0].identify === true, '開啟網址的按鍵記得住「要記錄是誰點的」');
  ok(!clean.buttons[1].identify, '發送文字的按鍵不會留下這個設定（用不到）');

  // 2) 發布時：勾了的走 LIFF 跳板，沒勾的走一般轉址
  let t = build({});
  const IMG = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');
  await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG });
  const createBody = t.dbCalls.find(c => /published_config=\$4/.test(c.f));
  ok(!!createBody, '發布有存下原始設定快照');
  // 從實際送給 LINE 的物件檢查網址
  const sentUris = [];
  t = build({});
  // build() 自己會裝一個 fetch，所以攔截器要在它之後才裝，否則會被蓋掉
  global.fetch = async (url, o) => {
    if (/\/v2\/bot\/richmenu$/.test(url) && o && o.method === 'POST') {
      JSON.parse(o.body).areas.forEach(a => { if (a.action && a.action.uri) sentUris.push(a.action.uri); });
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-n1' }) };
    }
    if (/user\/all\/richmenu$/.test(url) && (!o || o.method === 'GET'))
      return { ok: false, status: 404, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG });
  ok(sentUris.some(u => /liff\.line\.me\/1234-abcd\/t\/1\/0\/0$/.test(u)),
     '勾了的按鍵指到記名跳板（' + (sentUris[0] || '') + '）');
  ok(sentUris.some(u => /example\.netlify\.app\/r\/1\/0\/1$/.test(u)),
     '沒勾的按鍵維持原本的快速轉址（' + (sentUris[1] || '') + '）');

  // 3) 跳板頁：把真正的目的地交給前端，不是自己轉走
  t = build({});
  let r = await run(t.routes, 'GET /t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', null, { params: { id: '1', tab: '0', cell: '0' } });
  ok(r.rendered === 'tap_bounce' && r.locals.target === 'https://www.openrice.com/tw',
     '跳板頁帶著真正的目的地');
  ok(r.locals.recordUrl === '/t/1/0/0/hit' && r.locals.liffId === '1234-abcd', '跳板頁知道要回報到哪裡');

  // 4) 回報：記下是誰按的
  t = build({});
  r = await run(t.routes, 'POST /t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit',
    { line_user_id: UID }, { params: { id: '1', tab: '0', cell: '0' } });
  ok(t.taps.length === 1 && t.taps[0][4] === UID && t.taps[0][3] === '找餐廳',
     '記下了是誰按了哪一顆（含按鍵名稱）');

  // 5) 同一人連按只記一筆
  for (let i = 0; i < 3; i++)
    await run(t.routes, 'POST /t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit',
      { line_user_id: UID }, { params: { id: '1', tab: '0', cell: '0' } });
  ok(t.taps.length === 1, '同一人連按三次只記一筆');

  // 6) 亂湊的位置不記
  t = build({});
  await run(t.routes, 'POST /t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit',
    { line_user_id: UID }, { params: { id: '1', tab: '9', cell: '9' } });
  ok(t.taps.length === 0, '亂湊的按鍵位置不會被記成點擊');

  // 7) 假身分擋掉，但照樣放人過去
  t = build({});
  r = await run(t.routes, 'POST /t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit',
    { line_user_id: '我是假的' }, { params: { id: '1', tab: '0', cell: '0' } });
  ok(t.taps.length === 1 && t.taps[0][4] === null, '格式不對的身分記成「不知道是誰」，不會存進髒資料');

  // ── 訊息裡的按鈕 ──
  function buildMsg(opts) {
    opts = opts || {};
    const routes = {}, taps = [];
    const app = { get: (p2, ...h) => { routes['GET ' + p2] = h; },
                  post: (p2, ...h) => { routes['POST ' + p2] = h; }, delete: () => {}, put: () => {} };
    global.fetch = async () => ({ ok: false, status: 404, text: async () => '{}' });
    const query = async (sql, params) => {
      const f = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO message_taps/.test(f)) { taps.push(params); return { rows: [] }; }
      if (/FROM admin_keyword_replies k/.test(f)) {
        if (opts.noKeyword) return { rows: [] };
        return { rows: [{ message_config: { mode: 'template',
          template: { ctaUrl: 'https://www.openrice.com/promo', ctaLabel: '看優惠' } } }] };
      }
      return { rows: [] };
    };
    const pass = (req, r2, next) => next();
    registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
    return { routes, taps };
  }

  // 8) 關鍵字回覆的按鈕：跳板帶著設定裡的目的地
  let m = buildMsg({});
  r = await run(m.routes, 'GET /t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)', null,
    { params: { source: 'keyword', refId: '1_0' } });
  ok(r.rendered === 'tap_bounce' && r.locals.target === 'https://www.openrice.com/promo',
     '關鍵字回覆的按鈕跳板帶著正確目的地');

  // 9) 目的地一律回頭查設定，不從網址帶（不然變成誰都能拿它當轉址跳板）
  m = buildMsg({ noKeyword: true });
  r = await run(m.routes, 'GET /t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)', null,
    { params: { source: 'keyword', refId: '999_0' }, query: { url: 'https://evil.example.com' } });
  ok(r.redirected && r.redirected.indexOf('evil') === -1,
     '查不到設定就回自家頁面，不會被拿來轉址到別的地方');

  // 10) 回報記下是誰
  m = buildMsg({});
  await run(m.routes, 'POST /t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)/hit',
    { line_user_id: UID }, { params: { source: 'keyword', refId: '1_0' } });
  ok(m.taps.length === 1 && m.taps[0][0] === 'keyword' && m.taps[0][1] === '1_0' &&
     m.taps[0][2] === '看優惠' && m.taps[0][4] === UID,
     '記下誰點了哪一則訊息的哪顆按鈕');

  // 11) 同人連按只記一筆
  for (let i = 0; i < 3; i++)
    await run(m.routes, 'POST /t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)/hit',
      { line_user_id: UID }, { params: { source: 'keyword', refId: '1_0' } });
  ok(m.taps.length === 1, '訊息按鈕同一人連按三次也只記一筆');

  // 12) 指向自家活動頁（LIFF）的按鍵完全不包裝：原始連結直接送給 LINE。
  //     包成 /r 站內轉址會讓 LINE 先用內建瀏覽器開網址、再由 302 疊出 LIFF 視窗，
  //     使用者會在活動頁後面看到多一層灰色瀏覽器（2026-09-04 線上實測）。
  //     那些頁面自己認得出是誰、也記得到開啟次數，不需要任何跳板。
  {
    const OWN = { size: 'large', chat_bar_text: '選單',
      cells: [{ x: 0, y: 0, w: 1250, h: 1686 }, { x: 1250, y: 0, w: 1250, h: 1686 }],
      buttons: [
        { label: '今天吃什麼', identify: true, action: { type: 'uri', uri: 'https://liff.line.me/1234-abcd/wheel/x' } },
        { label: '立即訂位', identify: true, action: { type: 'uri', uri: 'https://s.openrice.com/abc' } }
      ] };
    const sent = [];
    const routes2 = {}; let created2 = 0;
    const app2 = { get: (p2, ...h) => { routes2['GET ' + p2] = h; },
                   post: (p2, ...h) => { routes2['POST ' + p2] = h; }, delete: () => {}, put: () => {} };
    const query2 = async (sql) => {
      const f = String(sql).replace(/\s+/g, ' ');
      if (/SELECT id, name, config, line_rich_menu_id/.test(f))
        return { rows: [{ id: 1, name: '長青', config: OWN, line_rich_menu_id: null, line_rich_menu_ids: null,
          is_default: false, audience_list_id: null, published_config: null, status: 'draft',
          published_at: null, audience_applied_at: null }] };
      return { rows: [] };
    };
    const pass2 = (rq, rs, nx) => nx();
    registerAdminRichMenuRoutes(app2, { query: query2, authCore: { requireAdmin: pass2, requireOwner: pass2 } });
    global.fetch = async (url, o) => {
      const method = (o && o.method) || 'GET';
      if (method === 'GET' && /user\/all\/richmenu$/.test(url)) return { ok: false, status: 404, text: async () => '{}' };
      if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url)) {
        created2++;
        JSON.parse(o.body).areas.forEach(a => { if (a.action && a.action.uri) sent.push(a.action.uri); });
        return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-own' }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const IMG2 = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');
    await run(routes2, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG2 });
    // 自家活動頁：原始 LIFF 連結原封不動送出，不包 /r 轉址也不走 /t 跳板
    ok(sent.some(u => u === 'https://liff.line.me/1234-abcd/wheel/x'),
       '自家活動頁的按鍵：保留原始 LIFF 連結');
    ok(!sent.some(u => /\/r\/1\/0\/0$/.test(u)),
       '自家活動頁的按鍵：不包站內轉址（會讓 LINE 多開一層內建瀏覽器）');
    // 別人家的 LIFF（合作夥伴活動頁）不算自家——那種頁面我們沒有任何紀錄
    ok(!isOwnLiffFn('https://liff.line.me/9999-partner/page'), '合作夥伴的活動頁不會被當成自家的');
    ok(!sent.some(u => /\/t\/1\/0\/0$/.test(u)), '自家活動頁的按鍵：不走記名跳板');
    ok(sent.some(u => /\/t\/1\/0\/1$/.test(u)), '外部網址勾了記名的照樣走跳板');
  }

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n記名追蹤全部通過');
  process.exit(failed ? 1 : 0);
})();
