// 發布／分頁／設預設／刪除／排程／名單／轉址的完整情境。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
process.env.SCHEDULED_RUNNER_SECRET = 'sch-secret';
process.env.URL = 'https://example.netlify.app';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }
const IMG = 'data:image/jpeg;base64,' + Buffer.from('fakejpg').toString('base64');

const ONE_TAB = { size: 'large', chat_bar_text: '選單',
  cells: [{ x: 0, y: 0, w: 2500, h: 1686 }],
  buttons: [{ label: '找餐廳', action: { type: 'uri', uri: 'https://www.openrice.com' } }] };
const TWO_TAB = { size: 'large', chat_bar_text: '選單',
  tabs: [
    { label: '活動', layout: 'big-1', cells: [{ x: 0, y: 176, w: 2500, h: 1510 }],
      buttons: [{ label: '玩', action: { type: 'uri', uri: 'https://liff.line.me/x/wheel/share-miles' } }] },
    { label: '服務', layout: 'big-1', cells: [{ x: 0, y: 176, w: 2500, h: 1510 }],
      buttons: [{ label: '客服', action: { type: 'message', text: '我想找客服' } }] }
  ] };

function build(opts) {
  opts = opts || {};
  const lineCalls = [], dbCalls = [], taps = [];
  let created = 0;
  global.fetch = async (url, o) => {
    const method = (o && o.method) || 'GET';
    lineCalls.push(method + ' ' + url);
    if (method === 'GET' && /user\/all\/richmenu$/.test(url)) {
      if (!opts.liveDefaultId) return { ok: false, status: 404, text: async () => '{}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: opts.liveDefaultId }) };
    }
    if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url)) {
      created++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-new' + created }) };
    }
    if (/\/content$/.test(url) && method === 'POST') {
      if (opts.uploadFailsAt && created === opts.uploadFailsAt)
        return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'image bad' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (method === 'POST' && /richmenu\/alias\//.test(url)) {
      if (opts.aliasUpdate404) return { ok: false, status: 404, text: async () => '{}' };
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (method === 'POST' && /richmenu\/alias$/.test(url)) return { ok: true, status: 200, text: async () => '{}' };
    if (method === 'POST' && /richmenu\/bulk\/(link|unlink)$/.test(url)) return { ok: true, status: 200, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  const row = { id: 1, name: '測試', is_default: false,
    line_rich_menu_id: opts.oldIds ? opts.oldIds[0] : 'richmenu-old9',
    line_rich_menu_ids: opts.oldIds ? opts.oldIds.map((x, i) => ({ tab: i, id: x, alias: 'crm-r1-t' + i })) : null,
    audience_list_id: opts.audienceListId || null,
    config: opts.config || ONE_TAB, published_config: opts.config || ONE_TAB,
    schedule_end_menu_id: null };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    dbCalls.push({ f, params });
    if (/INSERT INTO rich_menu_taps/.test(f)) { taps.push(params); return { rows: [] }; }
    if (/SELECT id, name, config, line_rich_menu_id, line_rich_menu_ids, is_default, audience_list_id/.test(f))
      return { rows: [row] };
    if (/SELECT published_config FROM rich_menus/.test(f)) return { rows: [row] };
    if (/SELECT line_rich_menu_id, line_rich_menu_ids, status FROM rich_menus/.test(f)) return { rows: [row] };
    if (/SELECT line_rich_menu_id, audience_list_id FROM rich_menus/.test(f))
      return { rows: [{ line_rich_menu_id: row.line_rich_menu_id, audience_list_id: row.audience_list_id }] };
    if (/SELECT line_rich_menu_id FROM rich_menus WHERE id=/.test(f))
      return { rows: [{ line_rich_menu_id: row.line_rich_menu_id }] };
    if (/FROM admin_test_recipients/.test(f))
      return { rows: opts.testers || [] };
    if (/SELECT line_user_id FROM admin_recipient_list_members/.test(f))
      return { rows: (opts.members || []).map(u => ({ line_user_id: u })) };
    if (/schedule_state='pending'/.test(f))
      return { rows: opts.pendingRows || [] };
    if (/schedule_state='live'/.test(f))
      return { rows: opts.liveRows || [] };
    if (opts.dbUpdateFails && /SET line_rich_menu_id=\$2/.test(f)) throw new Error('db timeout');
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, lineCalls, dbCalls, taps };
}
function res() { const o = { code: 200, body: null, redirected: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.render = () => o; o.redirect = u => { o.redirected = u; return o; }; return o; }
async function run(routes, key, reqBody, extras) {
  const hs = routes[key]; const r = res();
  const req = { body: reqBody || {}, query: {}, params: {}, authUser: { un: 'admin', adm: true },
                get: (h) => (extras && extras.headers && extras.headers[h]) || '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false;
    await hs[i](req, r, () => { called = true; });
    if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 單頁發布＋設預設：建→傳圖→寫DB→設預設→刪舊
  let t = build({});
  let r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: true });
  ok(r.body && r.body.ok === true, '單頁發布成功');
  let seq = t.lineCalls.join('\n');
  ok(seq.indexOf('POST https://api.line.me/v2/bot/richmenu') >= 0 &&
     seq.indexOf('/content') > seq.indexOf('POST https://api.line.me/v2/bot/richmenu') &&
     seq.indexOf('user/all/richmenu/richmenu-new1') > seq.indexOf('/content') &&
     seq.indexOf('DELETE https://api.line.me/v2/bot/richmenu/richmenu-old9') > seq.indexOf('user/all/richmenu/richmenu-new1'),
     '順序：建→傳圖→設預設→刪舊');
  ok(t.dbCalls.some(c => /SET is_default = \(id = \$1\)/.test(c.f)), '預設旗標用 id 比對');
  ok(t.dbCalls.some(c => /published_config=\$4::jsonb/.test(c.f)), '發布快照有存（轉址靠它查目的地）');

  // 2) 雙分頁發布：兩張選單、兩張圖、兩個別名，網址按鍵包成轉址
  t = build({ config: TWO_TAB, oldIds: ['richmenu-oldA', 'richmenu-oldB'] });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, images: [IMG, IMG], set_default: true });
  ok(r.body && r.body.ok === true && r.body.tabs === 2, '雙分頁發布成功');
  ok(t.lineCalls.filter(c => c === 'POST https://api.line.me/v2/bot/richmenu').length === 2, '建了兩張選單');
  ok(t.lineCalls.filter(c => /\/content$/.test(c)).length === 2, '傳了兩張圖');
  ok(t.lineCalls.filter(c => /alias/.test(c)).length >= 2, '兩個分頁別名都接好');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-oldA') &&
     t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-oldB'), '兩張舊選單都清掉');
  const pubBody = t.dbCalls.filter(c => /published_config/.test(c.f))[0];
  ok(pubBody && String(pubBody.params[3]).indexOf('/r/1/') < 0, '存進快照的是原始網址（不是追蹤網址）');

  // 3) 雙分頁圖片數不對 → 擋下
  t = build({ config: TWO_TAB });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, images: [IMG], set_default: false });
  ok(r.code === 400 && r.body.error === 'bad_image', '圖片數跟分頁數對不上要擋');

  // 4) 第二張圖傳失敗 → 兩張都刪、DB 沒動
  t = build({ config: TWO_TAB, uploadFailsAt: 2 });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, images: [IMG, IMG] });
  ok(r.code === 500, '傳圖失敗回錯誤');
  ok(t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-new1') &&
     t.lineCalls.some(c => c === 'DELETE https://api.line.me/v2/bot/richmenu/richmenu-new2'), '兩張半成品都刪掉');
  ok(!t.dbCalls.some(c => /status='published'/.test(c.f)), 'DB 沒動');

  // 5) 換掉現役選單 → 自動接手預設
  t = build({ liveDefaultId: 'richmenu-old9' });
  r = await run(t.routes, 'POST /admin/richmenu/api/publish', { id: 1, image: IMG, set_default: false });
  ok(r.body && r.body.is_default === true, '換掉現役選單時自動接手');

  // 6) set-default SQL 安全
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/api/set-default', { id: 1 });
  ok(r.body && r.body.ok === true && t.dbCalls.some(c => /IS NOT DISTINCT FROM/.test(c.f)), '設預設對草稿列安全');

  // 7) 刪除現役選單 → 擋
  t = build({ liveDefaultId: 'richmenu-old9' });
  r = await run(t.routes, 'POST /admin/richmenu/api/delete', { id: 1 });
  ok(r.code === 400 && r.body.error === 'is_live', '不准刪所有人正在看的');

  // 8) 刪除多分頁選單 → 別名跟選單一起清
  t = build({ oldIds: ['richmenu-oldA', 'richmenu-oldB'] });
  r = await run(t.routes, 'POST /admin/richmenu/api/delete', { id: 1 });
  ok(r.body && r.body.ok === true, '刪除成功');
  ok(t.lineCalls.some(c => /DELETE .*alias\/crm-r1-t0$/.test(c)) &&
     t.lineCalls.some(c => /DELETE .*alias\/crm-r1-t1$/.test(c)), '別名一起清掉');

  // 9) /r 轉址：記一筆、跳原始網址
  t = build({});
  r = await run(t.routes, 'GET /r/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', null, { params: { id: '1', tab: '0', cell: '0' } });
  ok(r.redirected === 'https://www.openrice.com', '轉址到原始網址（' + r.redirected + '）');
  ok(t.taps.length === 1 && t.taps[0][3] === '找餐廳', '記了一筆點擊（含按鍵名）');

  // 10) /r 查不到 → 跳保底頁，不會壞
  t = build({});
  r = await run(t.routes, 'GET /r/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', null, { params: { id: '1', tab: '5', cell: '9' } });
  ok(String(r.redirected).indexOf('https://') === 0, '亂打的位置也有地方跳');

  // 11) 排程：沒帶 secret 擋、帶了會跑上下架
  t = build({});
  r = await run(t.routes, 'POST /admin/richmenu/run-schedule', {}, { headers: {} });
  ok(r.code === 403, '排程執行沒帶通關密語要擋');
  t = build({ pendingRows: [{ id: 1, name: '測試', line_rich_menu_id: 'richmenu-old9' }] });
  r = await run(t.routes, 'POST /admin/richmenu/run-schedule', {}, { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  ok(r.body && r.body.ok && r.body.done.length === 1 && r.body.done[0].action === 'start', '到點自動上架');
  ok(t.lineCalls.some(c => /user\/all\/richmenu\/richmenu-old9$/.test(c)), '上架＝設為所有人看到的');

  // 12) 名單：套用會分批綁定
  const many = Array.from({ length: 7 }, (_, i) => 'U' + String(i).padStart(32, '0'));
  t = build({ members: many });
  r = await run(t.routes, 'POST /admin/richmenu/api/audience', { id: 1, list_id: 5 });
  ok(r.body && r.body.ok && r.body.applied === 7, '名單套用成功（7 人）');
  ok(t.lineCalls.some(c => /bulk\/link$/.test(c)), '有呼叫綁定');

  // 13) 取消名單 → 解除綁定
  t = build({ members: many, audienceListId: 5 });
  r = await run(t.routes, 'POST /admin/richmenu/api/audience', { id: 1, list_id: null });
  ok(r.body && r.body.ok && r.body.cleared === true, '取消名單專屬');
  ok(t.lineCalls.some(c => /bulk\/unlink$/.test(c)), '有解除綁定');

  // 14) 傳到測試手機：綁定測試人員、結束會解除、沒發布擋、清單空擋
  t = build({ testers: [{ label: 'Hen', line_user_id: 'U' + 'a'.repeat(32) },
                        { label: 'ice', line_user_id: 'U' + 'b'.repeat(32) }] });
  r = await run(t.routes, 'POST /admin/richmenu/api/preview', { id: 1 });
  ok(r.body && r.body.ok && r.body.count === 2, '傳給 2 位測試人員');
  ok(t.lineCalls.some(c => /bulk\/link$/.test(c)), '有綁定個人專屬選單');
  t = build({ testers: [{ label: 'Hen', line_user_id: 'U' + 'a'.repeat(32) }] });
  r = await run(t.routes, 'POST /admin/richmenu/api/preview', { stop: true });
  ok(r.body && r.body.stopped === true && t.lineCalls.some(c => /bulk\/unlink$/.test(c)), '結束預覽會解除綁定');
  t = build({ testers: [] });
  r = await run(t.routes, 'POST /admin/richmenu/api/preview', { id: 1 });
  ok(r.code === 400 && r.body.error === 'no_testers', '測試清單空的講清楚去哪加');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n路由情境全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
