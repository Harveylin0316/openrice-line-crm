// 自動貼標籤的後端：14 個事件、指定對象與時間範圍要走參數（擋 SQL 注入）、
// 測試帳號永遠排除、預覽不寫資料。
const path = require('path');
const { registerAdminUsersRoutes } = require(path.join(__dirname, '..', 'src/routes/adminUsers'));

process.env.SCHEDULED_RUNNER_SECRET = 'sch-secret';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function build(opts) {
  opts = opts || {};
  const calls = [];
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    calls.push({ f, params });
    if (/FROM user_tag_rules r JOIN user_tags/.test(f)) return { rows: opts.rules || [] };
    if (/INSERT INTO user_tag_members/.test(f)) return { rows: (opts.added || []).map(u => ({ line_user_id: u })) };
    if (/COUNT\(\*\)::int AS n/.test(f)) return { rows: [{ n: 6, names: ['小明', '小華'] }] };
    if (/FROM activities WHERE game_type/.test(f)) return { rows: [{ slug: 'share-miles', name: '分享超有哩' }] };
    if (/FROM rich_menus WHERE status/.test(f)) return { rows: [{ id: 3, name: '主選單' }] };
    if (/FROM admin_broadcasts WHERE status/.test(f)) return { rows: [{ id: 7, name: '八月推播' }] };
    if (/FROM line_follow_sources GROUP BY/.test(f)) return { rows: [{ source_key: 'poster_a', n: 12 }] };
    if (/FROM user_tags ORDER BY/.test(f)) return { rows: [{ id: 1, name: '常客', color: '#E8491D' }] };
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminUsersRoutes(app, { query, pool: { query },
    authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, calls };
}
function res() { const o = { code: 200, body: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.render = (v, d) => { o.rendered = v; return o; }; return o; }
async function run(routes, key, body, extras) {
  const hs = routes[key]; if (!hs) throw new Error('沒有這個路由：' + key);
  const r = res();
  const req = { body: body || {}, query: {}, params: {}, headers: {},
                authUser: { un: 'admin', adm: true },
                get: h => (extras && extras.headers && extras.headers[h]) || '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false;
    await hs[i](req, r, () => { called = true; });
    if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 事件目錄有出來，而且每個都講得出「可以挑什麼」
  let t = build({});
  let r = await run(t.routes, 'GET /admin/users/api/tag-rules');
  const cat = r.body.catalog;
  ok(cat && cat.length >= 14, '事件至少 14 種（' + (cat ? cat.length : 0) + '）');
  ok(cat.every(c => c.label && c.unit && c.target_kind), '每個事件都有名稱、單位、挑選方式');
  ok(cat.every(c => !/[a-z_]{4,}/.test(c.label)), '事件名稱都是人話，沒有代號');
  ok(r.body.targets.activity[0].label === '分享超有哩' &&
     r.body.targets.menu[0].label === '主選單' &&
     r.body.targets.broadcast[0].label === '八月推播', '可以挑的活動／選單／群發都撈出來了');

  // 2) 指定對象一律走參數，不接進 SQL 文字（SQL 注入）
  t = build({ rules: [{ id: 1, tag_id: 1, rule_kind: 'played', threshold: 1,
    target: "x'; DROP TABLE users; --", window_days: 30, tag_name: '常客' }] });
  await run(t.routes, 'POST /admin/users/run-tag-rules', {}, { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  const ins = t.calls.find(c => /INSERT INTO user_tag_members/.test(c.f));
  ok(ins && ins.f.indexOf('DROP TABLE') === -1, '亂打的對象沒有被接進 SQL 文字裡');
  ok(ins && ins.params.indexOf("x'; DROP TABLE users; --") >= 0, '它是被當成參數傳的');
  ok(ins && ins.params[3] === 30, '時間範圍也是參數');

  // 3) 測試帳號與非標準編號永遠排除
  ok(ins && /admin_test_recipients/.test(ins.f) && /\^U\[0-9a-f\]\{32\}\$/.test(ins.f),
     '測試帳號與亂編號永遠不會被貼');

  // 4) 不用挑對象的事件，就算硬送對象也不存
  t = build({});
  await run(t.routes, 'POST /admin/users/api/tag-rules',
    { tag_id: 1, rule_kind: 'joined_days', threshold: 7, target: '亂送的' });
  const cre = t.calls.find(c => /INSERT INTO user_tag_rules/.test(c.f));
  ok(cre && cre.params[3] === null, '不需要挑對象的事件不會存下多餘的東西');

  // 5) 門檻與天數有上下限（避免打爆資料庫）
  t = build({});
  await run(t.routes, 'POST /admin/users/api/tag-rules',
    { tag_id: 1, rule_kind: 'played', threshold: 999999, window_days: 99999 });
  const cre2 = t.calls.find(c => /INSERT INTO user_tag_rules/.test(c.f));
  ok(cre2 && cre2.params[2] === 100000 && cre2.params[5] === 3650, '離譜的數字會被收進合理範圍');

  // 6) 預覽只查不寫
  t = build({});
  r = await run(t.routes, 'POST /admin/users/api/tag-rules/preview',
    { rule_kind: 'won_prize', threshold: 1, target: 'share-miles' });
  ok(r.body.ok && r.body.count === 6 && r.body.names[0] === '小明', '預覽回人數與名字');
  ok(!t.calls.some(c => /INSERT|UPDATE|DELETE/.test(c.f)), '預覽完全不寫資料');

  // 7) 亂送的事件代號要擋
  t = build({});
  r = await run(t.routes, 'POST /admin/users/api/tag-rules/preview', { rule_kind: 'not_a_real_kind' });
  ok(r.code === 400, '沒有的事件代號會被擋');
  t = build({});
  r = await run(t.routes, 'POST /admin/users/api/tag-rules', { tag_id: 1, rule_kind: 'not_a_real_kind' });
  ok(r.code === 400 && !t.calls.some(c => /INSERT INTO user_tag_rules/.test(c.f)), '也不會被存進去');

  // 8) 頁面路由掛好了
  t = build({});
  r = await run(t.routes, 'GET /admin/tag-rules');
  ok(r.rendered === 'admin_tag_rules', '自動貼標籤有自己的頁面');

  // 9) 排程沒帶通關密語要擋
  t = build({});
  r = await run(t.routes, 'POST /admin/users/run-tag-rules', {}, { headers: {} });
  ok(r.code === 403, '排程沒帶通關密語擋下來');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n自動貼標籤後端全部通過');
  process.exit(failed ? 1 : 0);
})();
