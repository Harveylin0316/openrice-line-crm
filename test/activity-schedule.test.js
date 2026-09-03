// 活動上下架排程：時間到自動換狀態，暫停的不碰。
const path = require('path');
const { registerAdminActivitiesRoutes } = require(path.join(__dirname, '..', 'src/routes/adminActivities'));
process.env.SCHEDULED_RUNNER_SECRET = 'sch-secret';
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function build(opts) {
  opts = opts || {};
  const calls = [];
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; },
                put: (p, ...h) => { routes['PUT ' + p] = h; }, delete: () => {}, patch: () => {} };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    calls.push({ f, params });
    if (/SET status='ended'/.test(f)) return { rows: opts.toEnd || [] };
    if (/SET status='active'/.test(f)) return { rows: opts.toStart || [] };
    return { rows: [] };
  };
  const pass = (req, res, next) => next();
  registerAdminActivitiesRoutes(app, { query, pool: { query, connect: async () => ({ query, release() {} }) },
    authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, calls };
}
function res() { const o = { code: 200, body: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; }; o.render = () => o; return o; }
async function run(routes, key, body, extras) {
  const hs = routes[key]; const r = res();
  const req = { body: body || {}, query: {}, params: {}, headers: {}, authUser: { un: 'admin', adm: true },
                get: h => (extras && extras.headers && extras.headers[h]) || '', ...(extras || {}) };
  for (let i = 0; i < hs.length; i++) {
    let called = false; await hs[i](req, r, () => { called = true; }); if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 到開始時間 → 自動變進行中；到結束時間 → 自動變已結束
  let t = build({ toStart: [{ id: 2, name: '九月活動' }], toEnd: [{ id: 1, name: '八月活動' }] });
  let r = await run(t.routes, 'POST /admin/activities/run-schedule', {}, { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
  ok(r.body.ok && r.body.done.length === 2, '兩件事都做了');
  ok(r.body.done[0].action === 'end' && r.body.done[1].action === 'start',
     '先收舊活動再開新活動（同時間換檔才不會打架）');

  // 2) 只動該動的：暫停不碰、沒設時間不碰
  const endSql = t.calls.find(c => /SET status='ended'/.test(c.f)).f;
  const startSql = t.calls.find(c => /SET status='active'/.test(c.f)).f;
  ok(/status='active'/.test(endSql) && /end_at IS NOT NULL/.test(endSql),
     '只把「進行中且有設結束時間」的收掉');
  ok(/status='draft'/.test(startSql) && /start_at IS NOT NULL/.test(startSql),
     '只把「草稿且有設開始時間」的打開');
  ok(!/paused/.test(endSql) && !/paused/.test(startSql), '人為暫停的活動一律不碰');
  ok(/end_at IS NULL OR end_at > now\(\)/.test(startSql),
     '結束時間已過的活動不會被誤開');

  // 3) 沒帶通關密語要擋
  t = build({});
  r = await run(t.routes, 'POST /admin/activities/run-schedule', {}, { headers: {} });
  ok(r.code === 403 && !t.calls.some(c => /SET status=/.test(c.f)), '沒帶通關密語不會動到任何活動');

  // 4) 後台可以手動立刻套用
  t = build({ toStart: [{ id: 5, name: '測試' }] });
  r = await run(t.routes, 'POST /admin/activities/api/apply-schedule');
  ok(r.body.ok && r.body.done.length === 1, '後台可以不等五分鐘，馬上套用時間');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n活動排程全部通過');
  process.exit(failed ? 1 : 0);
})();
