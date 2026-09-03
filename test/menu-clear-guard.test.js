// 「讓所有人看不到選單」是危險操作：實測確認它會連 LINE 官方後台設的長青選單
// 一起關掉，而且不會自動回來。這支測試把三道防線鎖住。
const path = require('path');
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
process.env.SCHEDULED_RUNNER_SECRET = 'sch-secret';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function build(opts) {
  opts = opts || {};
  const lineCalls = [], routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  global.fetch = async (url, o) => {
    const method = (o && o.method) || 'GET';
    lineCalls.push(method + ' ' + url);
    if (method === 'GET' && /user\/all\/richmenu$/.test(url)) {
      // ownedElsewhere：官方後台的長青選單正在生效（LINE 實際回 403）
      if (opts.ownedElsewhere) return { ok: false, status: 403, text: async () => JSON.stringify({ message: 'the richmenu is owned by another channel' }) };
      if (opts.liveDefaultId) return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: opts.liveDefaultId }) };
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no default richmenu' }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    if (/schedule_state='live' AND schedule_end_at/.test(f)) return { rows: opts.liveRows || [] };
    if (/schedule_state='pending'/.test(f)) return { rows: [] };
    if (/SELECT line_rich_menu_id, line_rich_menu_ids FROM rich_menus/.test(f))
      return { rows: [{ line_rich_menu_id: 'richmenu-mine', line_rich_menu_ids: null }] };
    if (/SELECT line_rich_menu_id FROM rich_menus WHERE id=/.test(f))
      return { rows: [{ line_rich_menu_id: 'richmenu-other' }] };
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, lineCalls };
}
function res() { const o = { code: 200, body: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.render = () => o; o.redirect = u => { o.redirected = u; return o; }; return o; }
async function run(routes, key, body, extras) {
  const hs = routes[key]; const r = res();
  const req = { body: body || {}, query: {}, params: {}, headers: {},
                authUser: { un: 'admin', adm: true },
                get: h => (extras && extras.headers && extras.headers[h]) || '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false; await hs[i](req, r, () => { called = true; }); if (!called) break;
  }
  return r;
}
const future = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

(async () => {
  // ── 防線 1：排程存檔時，沒指定接手的選單要擋下來 ──
  let t = build({ liveDefaultId: 'richmenu-mine' });
  let r = await run(t.routes, 'POST /admin/richmenu/api/schedule',
    { id: 1, start_at: future(1), end_at: future(48) });
  ok(r.code === 400 && r.body.error === 'no_end_menu', '沒指定接手選單的排程會被擋下來');
  ok(/不會自動回來/.test(r.body.detail || ''), '錯誤訊息講清楚後果（不會自動回來）');

  // 明講「我知道」才給排
  t = build({ liveDefaultId: 'richmenu-mine' });
  r = await run(t.routes, 'POST /admin/richmenu/api/schedule',
    { id: 1, start_at: future(1), end_at: future(48), confirm_no_menu: true });
  ok(r.body && r.body.ok === true, '明確確認過就給排');

  // 指定了接手選單就正常放行
  t = build({ liveDefaultId: 'richmenu-mine' });
  r = await run(t.routes, 'POST /admin/richmenu/api/schedule',
    { id: 1, start_at: future(1), end_at: future(48), end_menu_id: 2 });
  ok(r.body && r.body.ok === true, '有指定接手選單就直接放行（建議作法）');

  // ── 防線 2：clear-default 要明確確認 ──
  t = build({ liveDefaultId: 'richmenu-mine' });
  r = await run(t.routes, 'POST /admin/richmenu/api/clear-default', {});
  ok(r.code === 400 && !t.lineCalls.some(c => /DELETE .*user\/all\/richmenu$/.test(c)),
     '沒確認就要求取消全體選單，不會真的動手');
  t = build({ liveDefaultId: 'richmenu-mine' });
  r = await run(t.routes, 'POST /admin/richmenu/api/clear-default', { confirm: true });
  ok(r.body && r.body.ok === true, '確認過才真的取消');

  // ── 防線 3（最重要）：排程執行時，官方後台的長青選單絕不能被誤關 ──
  t = build({ ownedElsewhere: true,
    liveRows: [{ id: 1, name: '活動選單', line_rich_menu_id: 'richmenu-mine',
                 line_rich_menu_ids: null, schedule_end_menu_id: null }] });
  r = await run(t.routes, 'POST /admin/richmenu/run-schedule', {},
    { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  ok(!t.lineCalls.some(c => /DELETE .*user\/all\/richmenu$/.test(c)),
     '檯面上是官方後台的長青選單時，排程下架不會去關它');
  ok(r.body.done[0].action === 'end_skipped_not_live', '而且照實記成「跳過」');

  // 檯面上真的是自己時，才照當初確認過的行為清空
  t = build({ liveDefaultId: 'richmenu-mine',
    liveRows: [{ id: 1, name: '活動選單', line_rich_menu_id: 'richmenu-mine',
                 line_rich_menu_ids: null, schedule_end_menu_id: null }] });
  await run(t.routes, 'POST /admin/richmenu/run-schedule', {},
    { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  ok(t.lineCalls.some(c => /DELETE .*user\/all\/richmenu$/.test(c)),
     '檯面上是自己的選單時，才照排程清空（存檔時已確認過）');

  // 有接手選單時，是換過去而不是清空
  t = build({ liveDefaultId: 'richmenu-mine',
    liveRows: [{ id: 1, name: '活動選單', line_rich_menu_id: 'richmenu-mine',
                 line_rich_menu_ids: null, schedule_end_menu_id: 2 }] });
  await run(t.routes, 'POST /admin/richmenu/run-schedule', {},
    { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  ok(!t.lineCalls.some(c => /DELETE .*user\/all\/richmenu$/.test(c)) &&
     t.lineCalls.some(c => /POST .*user\/all\/richmenu\/richmenu-other$/.test(c)),
     '有指定接手選單時是換過去，不會經過「沒有選單」的空窗');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n清空選單的三道防線都鎖住了');
  process.exit(failed ? 1 : 0);
})();
