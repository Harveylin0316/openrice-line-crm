const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerAdminHubRoutes } = require('../src/routes/adminHub');

function setup() {
  const routes = {};
  const writes = [];
  const app = {
    get(route, ...handlers) { routes['GET ' + route] = handlers; },
    post(route, ...handlers) { routes['POST ' + route] = handlers; }
  };
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/SELECT id, name, status, start_at, end_at, liff_id_override/.test(q)) {
      return { rows: [{
        id: 7, name: '旅電', status: 'active', start_at: new Date('2026-08-13T00:00:00+08:00'),
        end_at: new Date('2026-09-28T23:59:00+08:00'), liff_id_override: '123-abc', partner_machine_scans: 2
      }] };
    }
    if (/SELECT id, prize_value FROM activity_prizes/.test(q)) return { rows: [{ id: 23, prize_value: {} }] };
    if (/COUNT\(\*\)::int AS total,[\s\S]*status IN \('claimed','redeemed'\)/.test(q)) {
      return { rows: [{ total: 1000, available: 965, claimed: 35, today_claims: 0 }] };
    }
    if (/COUNT\(\*\)::int AS total,[\s\S]*code LIKE/.test(q)) return { rows: [{ total: 0, available: 0 }] };
    if (/to_char\(date_trunc/.test(q)) return { rows: [] };
    if (/FROM admin_keyword_replies/.test(q)) return { rows: [{ hits: 70, is_active: true, keywords: '借電券' }] };
    if (/FROM liff_token_probe/.test(q)) return { rows: [{ opens: 65 }] };
    if (/COUNT\(DISTINCT claimed_line_user_id\)::int AS n[\s\S]*claimed_line_user_id IS NOT NULL AND code NOT LIKE/.test(q) && !/redeemed_at IS NOT NULL/.test(q)) {
      return { rows: [{ n: 35 }] };
    }
    if (/FROM activity_plays/.test(q) && /redeem_clicked_at/.test(q)) return { rows: [{ n: 10 }] };
    if (/redeemed_at IS NOT NULL/.test(q)) return { rows: [{ n: 0 }] };
    if (/claimed_at >= now\(\) - interval '7 days'/.test(q)) return { rows: [{ n: 7 }] };
    if (/AS new_friends/.test(q)) return { rows: [{ new_friends: 12, claimers_new: 3 }] };
    if (/UPDATE activities[\s\S]*partner_metrics/.test(q)) {
      writes.push(params);
      return { rows: [{ machine_scans: Number(params[1]) }] };
    }
    throw new Error('測試沒有處理這個 SQL：' + q.slice(0, 160));
  };
  const pass = (_req, _res, next) => next();
  registerAdminHubRoutes(app, { query, pool: { query }, authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, writes };
}

function response() {
  const res = { code: 200, body: null };
  res.status = code => { res.code = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.render = () => res;
  return res;
}

async function run(routes, key, body = {}) {
  const res = response();
  const req = { body, query: {}, params: {}, authUser: { un: 'admin', adm: true } };
  for (const handler of routes[key]) {
    let next = false;
    await handler(req, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

test('旅電成效回到開頁、領取、兌換、機台掃碼四段', async () => {
  const { routes } = setup();
  const res = await run(routes, 'GET /admin/campaigns/ludian/api/overview');
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.funnel, {
    opens: 65,
    claimers: 35,
    redeem_clickers: 10,
    machine_scans: 2,
    machine_scans_source: 'partner_report'
  });
  assert.equal('card_sends' in res.body.funnel, false, '收到卡片不再冒充轉換指標');
});

test('機台掃碼可更新，並擋住空白與非整數', async () => {
  const { routes, writes } = setup();
  let res = await run(routes, 'POST /admin/campaigns/ludian/api/partner-metrics', { machine_scans: 4 });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.machine_scans, 4);
  assert.deepEqual(writes[0], ['ludian-0901', 4]);

  res = await run(routes, 'POST /admin/campaigns/ludian/api/partner-metrics', { machine_scans: '' });
  assert.equal(res.code, 400);
  res = await run(routes, 'POST /admin/campaigns/ludian/api/partner-metrics', { machine_scans: 1.5 });
  assert.equal(res.code, 400);
});

test('畫面把四段漏斗放回主要位置', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views/admin_campaign_ludian.ejs'), 'utf8');
  for (const label of ['打開領取頁（人）', '完成領取（人）', '點兌換（人）', '機台掃碼（人）']) {
    assert.match(view, new RegExp(label));
  }
  assert.doesNotMatch(view, /收到卡片（次）/);
  assert.match(view, /機台掃碼」來自旅電回報/);
});
