// 數據總覽 + 用戶標籤：資料端點形狀、LINE 掛掉不擋頁、標籤增刪貼撕與存成名單。
const path = require('path');
const { registerAdminInsightRoutes } = require(path.join(__dirname, '..', 'src/routes/adminInsight'));
const { registerAdminUsersRoutes } = require(path.join(__dirname, '..', 'src/routes/adminUsers'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }
function res() { const o = { code: 200, body: null }; o.status = c => { o.code = c; return o; };
  o.json = b => { o.body = b; return o; }; o.render = v => { o.body = { render: v }; return o; }; return o; }
async function run(routes, key, opts) {
  const hs = routes[key]; const r = res();
  const req = { body: (opts && opts.body) || {}, query: (opts && opts.q) || {}, params: (opts && opts.params) || {},
                authUser: { un: 'admin', adm: true }, get: () => '' };
  for (let i = 0; i < hs.length; i++) {
    let called = false;
    await hs[i](req, r, () => { called = true; });
    if (!called) break;
  }
  return r;
}
function appStub(routes) {
  return { get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; },
           delete: () => {}, put: () => {} };
}

(async () => {
  // ── 數據總覽 ──
  let routes = {};
  const dailyRow = { day: '08/21', joins: 5, blocks: 1, msgs: 20, menu_taps: 3, plays: 2, referrals: 1 };
  const insightQuery = async (sql) => {
    const f = String(sql).replace(/\s+/g, ' ');
    if (/generate_series/.test(f)) return { rows: [dailyRow] };
    if (/FILTER \(WHERE line_user_id IS NOT NULL AND is_admin = false\)::int AS members/.test(f))
      return { rows: [{ members: 1500, blocked: 59, joined_period: 300 }] };
    if (/FROM line_follow_sources/.test(f)) return { rows: [{ source_key: 'organic', n: 100 }] };
    if (/FROM rich_menu_taps t LEFT JOIN rich_menus/.test(f)) return { rows: [] };
    if (/JOIN activities a ON/.test(f)) return { rows: [{ name: '分享超有哩', plays: 10, wins: 3, people: 6 }] };
    return { rows: [] };
  };
  global.fetch = async (url) => ({ ok: true, status: 200,
    text: async () => JSON.stringify(/followers/.test(url) ? { followers: 1551, targetedReaches: 1491, blocks: 59 } :
      /demographic/.test(url) ? { available: true, genders: [{ gender: 'female', percentage: 60.3 }] } :
      { autoResponse: 156 }) });
  const pass = (req, res2, next) => next();
  registerAdminInsightRoutes(appStub(routes), { query: insightQuery, authCore: { requireAdmin: pass } });
  let r = await run(routes, 'GET /admin/insight/api/data', { q: { days: '30' } });
  ok(r.body && r.body.ok, '數據端點成功');
  ok(r.body.line.followers.followers === 1551, 'LINE 官方數字有帶');
  ok(r.body.daily.length === 1 && r.body.daily[0].joins === 5, '每日資料有帶');
  ok(r.body.totals.members === 1500, '會員總數有帶');

  // LINE 全掛 → 頁面照出，官方欄位是 null
  routes = {};
  global.fetch = async () => { throw new Error('network down'); };
  registerAdminInsightRoutes(appStub(routes), { query: insightQuery, authCore: { requireAdmin: pass } });
  r = await run(routes, 'GET /admin/insight/api/data', {});
  ok(r.body && r.body.ok && r.body.line.followers === null, 'LINE 掛掉不擋頁，自家數字照出');

  // ── 標籤 ──
  routes = {};
  const dbCalls = [];
  const tagQuery = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    dbCalls.push({ f, params });
    if (/FROM user_tags t ORDER BY/.test(f)) return { rows: [{ id: 1, name: 'VIP', color: '#E8491D', members: 3 }] };
    if (/INSERT INTO user_tags/.test(f)) return { rows: [{ id: 2, name: params[0], color: params[1] }] };
    if (/SELECT name FROM user_tags/.test(f)) return { rows: [{ name: 'VIP' }] };
    if (/SELECT line_user_id FROM user_tag_members/.test(f))
      return { rows: [{ line_user_id: 'U' + 'a'.repeat(32) }] };
    if (/INSERT INTO admin_recipient_lists/.test(f)) return { rows: [{ id: 9, name: params[0], total: params[2] }] };
    return { rows: [] };
  };
  registerAdminUsersRoutes(appStub(routes), { query: tagQuery, authCore: { requireAdmin: pass } });

  r = await run(routes, 'GET /admin/users/api/tags', {});
  ok(r.body && r.body.ok && r.body.tags[0].name === 'VIP', '標籤列表');
  r = await run(routes, 'POST /admin/users/api/tags', { body: { name: '常客', color: '#2E7D32' } });
  ok(r.body && r.body.ok && r.body.tag.name === '常客', '建立標籤');
  r = await run(routes, 'POST /admin/users/api/tags', { body: { name: '' } });
  ok(r.code === 400, '沒名字要擋');
  r = await run(routes, 'POST /admin/users/api/tag', { body: { line_user_id: 'U' + 'a'.repeat(32), tag_id: 1, on: true } });
  ok(r.body && r.body.ok && dbCalls.some(c => /INSERT INTO user_tag_members/.test(c.f)), '貼標籤');
  r = await run(routes, 'POST /admin/users/api/tag', { body: { line_user_id: 'U' + 'a'.repeat(32), tag_id: 1, on: false } });
  ok(r.body && r.body.ok && dbCalls.some(c => /DELETE FROM user_tag_members/.test(c.f)), '撕標籤');
  r = await run(routes, 'POST /admin/users/api/tags/to-list', { body: { tag_id: 1 } });
  ok(r.body && r.body.ok && r.body.list.total === 1, '標籤存成名單');
  r = await run(routes, 'POST /admin/users/api/tag', { body: { line_user_id: 'bad', tag_id: 1 } });
  ok(r.code === 400, '亂寫的編號要擋');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n數據總覽與標籤全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
