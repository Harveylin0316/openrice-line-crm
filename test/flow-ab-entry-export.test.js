'use strict';
// 自動化流程：A/B 分組（沿用群發版本／隨機 50/50）、進入條件、派送紀錄匯出；
// 名單與進入條件的條件組（混用 AND／OR）；圖文選單成效期間；訊息成效標示版本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compileAudience, cleanDefinition } = require('../src/core/audienceSegments');
const { registerAdminFlowsRoutes } = require('../src/routes/adminFlows');
const { createFlowEngine } = require('../src/core/flowEngine');
const { registerAdminRichMenuRoutes } = require('../src/routes/adminRichMenu');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const U = c => 'U' + c.repeat(32);
function makeApp(routes) {
  return ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
}
async function run(handlers, req) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
  for (const h of handlers) { let nx = false; await h(Object.assign({ authUser: { un: 'admin' }, params: {}, query: {} }, req), res, () => { nx = true; }); if (!nx) break; }
  return res;
}

// ------------------------------------------------------------- 條件組
test('條件組：是好友 AND（點過 A OR 點過 B）；組內不能再放組；排除整組', () => {
  const c = compileAudience({ operator: 'and', conditions: [
    { type: 'is_friend' },
    { type: 'group', operator: 'or', conditions: [{ type: 'rich_menu_button', value: '9:1:0' }, { type: 'rich_menu_button', value: '7:1:0' }] }] });
  assert.ok(c.where.startsWith('((u.blocked_at IS NULL AND u.archived_at IS NULL) AND ((('), '好友 AND（組）');
  assert.ok(c.where.includes(')) OR (EXISTS'), '組內用 OR 串接');
  assert.deepEqual(c.params, [9, 1, 0, 7, 1, 0]);
  assert.throws(() => cleanDefinition({ conditions: [{ type: 'group', conditions: [{ type: 'group', conditions: [{ type: 'is_friend' }] }] }] }), /條件組裡不能再放條件組/);
  assert.throws(() => cleanDefinition({ conditions: [{ type: 'group', conditions: [] }] }), /條件組裡至少要有一個條件/);
  const ex = compileAudience({ operator: 'and', conditions: [{ type: 'is_friend' }, { type: 'group', mode: 'exclude', operator: 'or', conditions: [{ type: 'tag', value: 3 }] }] });
  assert.match(ex.where, /AND NOT \(\(\(EXISTS/);
});

// ------------------------------------------------------------- 流程儲存
function saveHarness() {
  const routes = {}; const nodes = []; let savedConfig = null;
  const client = { async query(sql, p) {
    const s = String(sql);
    if (/INSERT INTO admin_flows/.test(s)) { savedConfig = JSON.parse(p[3] || p[2] || '{}'); return { rows: [{ id: 5 }], rowCount: 1 }; }
    if (/INSERT INTO admin_flow_nodes/.test(s)) { nodes.push({ node_key: p[1], type: p[2], config: JSON.parse(p[3]), next_key: p[4], branch_true_key: p[5], branch_false_key: p[6], is_entry: p[7] }); }
    return { rows: [], rowCount: 0 }; }, release() {} };
  registerAdminFlowsRoutes(makeApp(routes), { query: async () => ({ rows: [], rowCount: 0 }), pool: { connect: async () => client }, flowEngine: {},
    authCore: { requireAdmin: (_q, _s, n) => n() } });
  return { routes, nodes, saved: () => savedConfig };
}
const abStep = (o) => Object.assign({ type: 'ab_split', mode: 'broadcast', broadcast_id: 90,
  a: [{ type: 'wait', amount: 1, unit: 'days' }, { type: 'send', message_id: 11 }], b: [{ type: 'send', message_id: 12 }], c: [{ type: 'send', message_id: 13 }] }, o || {});

test('儲存 A/B 分組：A＝branch_true、B＝branch_false、C 存在 config.c_key；檢查必填', async () => {
  const h = saveHarness();
  const res = await run(h.routes['POST /admin/flows/api'], { body: { name: 'AB', trigger: { type: 'follow', config: {} }, steps: [abStep()] } });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  const ab = h.nodes.find(n => n.type === 'ab_split');
  assert.deepEqual([ab.config.mode, ab.config.broadcast_id, !!ab.branch_true_key, !!ab.branch_false_key, !!ab.config.c_key, ab.is_entry], ['broadcast', 90, true, true, true, true]);
  const aFirst = h.nodes.find(n => n.node_key === ab.branch_true_key);
  assert.equal(aFirst.type, 'wait', 'A 路線第一步是等待 1 天');
  const errOf = async (step, extra) => (await run(saveHarness().routes['POST /admin/flows/api'], { body: { name: 'x', trigger: { type: 'follow', config: {} }, steps: [].concat(extra || [], step) } })).body.error;
  assert.equal(await errOf(abStep({ broadcast_id: null })), 'ab_split_needs_broadcast');
  assert.equal(await errOf(abStep({ b: [] })), 'ab_split_needs_both_paths');
  assert.equal(await errOf(abStep({ a: [{ type: 'ab_split' }] })), 'branch_sub_only_send_wait');
  assert.equal(await errOf([abStep(), { type: 'send', message_id: 1 }]), 'branch_must_be_last');
  assert.equal(await errOf(abStep({ mode: 'random', broadcast_id: null })), undefined, '隨機模式不需要群發');
});

test('儲存進入條件：清理後存進 trigger_config；格式錯誤擋下；空的不存', async () => {
  const h = saveHarness();
  const ok = await run(h.routes['POST /admin/flows/api'], { body: { name: 'E', trigger: { type: 'rich_menu_tap', config: { menu_id: 9, match: 'any', buttons: [],
    entry_conditions: { operator: 'and', conditions: [{ type: 'joined_after', value: '2026-11-13' }, { type: 'broadcast_sent', mode: 'exclude', value: '90' }] } } },
    steps: [{ type: 'send', message_id: 1 }] } });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.deepEqual(h.saved().entry_conditions, { version: 1, operator: 'and', conditions: [{ type: 'joined_after', mode: 'include', value: '2026-11-13' }, { type: 'broadcast_sent', mode: 'exclude', value: 90 }] });
  const h2 = saveHarness();
  const bad = await run(h2.routes['POST /admin/flows/api'], { body: { name: 'E', trigger: { type: 'follow', config: { entry_conditions: { conditions: [{ type: 'joined_after', value: '11/13' }] } } }, steps: [{ type: 'send', message_id: 1 }] } });
  assert.equal(bad.body.error, 'invalid_entry_conditions');
  const h3 = saveHarness();
  await run(h3.routes['POST /admin/flows/api'], { body: { name: 'E', trigger: { type: 'follow', config: { entry_conditions: { conditions: [] } } }, steps: [{ type: 'send', message_id: 1 }] } });
  assert.equal('entry_conditions' in h3.saved(), false);
});

// ------------------------------------------------------------- 引擎
function engineHarness({ broadcastVariant = null, entryHit = true } = {}) {
  const updates = [];
  const query = async (sql, p) => {
    const s = String(sql);
    if (/FROM admin_broadcast_recipients/.test(s)) return { rows: broadcastVariant ? [{ variant: broadcastVariant }] : [], rowCount: broadcastVariant ? 1 : 0 };
    if (/UPDATE admin_flow_enrollments SET context = COALESCE/.test(s)) { updates.push(JSON.parse(p[1])); return { rows: [], rowCount: 1 }; }
    if (/SELECT \* FROM admin_flow_nodes WHERE flow_id = \$1 AND is_entry/.test(s)) return { rows: [{ node_key: 'n1' }], rowCount: 1 };
    if (/FROM users u/.test(s)) return { rows: entryHit ? [{ line_user_id: U('a') }] : [], rowCount: entryHit ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  };
  const engine = createFlowEngine({ query, pool: { connect: async () => ({ query, release() {} }) }, linePush: {}, buildLineMessages: () => ({ ok: true, messages: [] }) });
  return { engine, updates };
}

test('進入條件：不符合不進入；條件查詢出錯也不進入（避免誤發）', async () => {
  const flow = { id: 3, re_enroll: true, trigger_config: { entry_conditions: { operator: 'and', conditions: [{ type: 'joined_after', value: '2026-11-13' }] } } };
  assert.equal((await engineHarness({ entryHit: false }).engine.enrollUser(flow, U('a'))).reason, 'entry_conditions_not_met');
  const broken = createFlowEngine({ query: async (sql) => { if (/FROM users u/.test(String(sql))) throw new Error('db'); return /is_entry/.test(String(sql)) ? { rows: [{ node_key: 'n1' }], rowCount: 1 } : { rows: [], rowCount: 0 }; },
    pool: {}, linePush: {}, buildLineMessages: () => ({ ok: true, messages: [] }) });
  assert.equal((await broken.enrollUser(flow, U('a'))).reason, 'entry_conditions_error');
});

test('A/B 分組：沿用群發版本；C 沒有路線或沒收過 → 固定 50/50；已分過的沿用；寫進 context', async () => {
  const half = (fid, luid) => (crypto.createHash('sha256').update('flow-ab:' + fid + ':' + luid).digest()[0] & 1) === 0 ? 'a' : 'b';
  const node = (cfg) => ({ node_key: 'n1', type: 'ab_split', config: cfg, branch_true_key: 'A', branch_false_key: 'B' });
  // 直接測試引擎的分組結果：用 _processEnrollment 走到 A/B 後的節點
  async function decide(variantInBroadcast, cfg, context) {
    const seen = [];
    const query = async (sql, p) => {
      const s = String(sql);
      if (/FROM admin_flow_nodes WHERE flow_id = \$1 AND node_key = \$2/.test(s)) {
        if (p[1] === 'n1') return { rows: [node(cfg)], rowCount: 1 };
        seen.push(p[1]); return { rows: [{ node_key: p[1], type: 'end' }], rowCount: 1 };
      }
      if (/FROM admin_broadcast_recipients/.test(s)) return { rows: variantInBroadcast ? [{ variant: variantInBroadcast }] : [], rowCount: variantInBroadcast ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    };
    const engine = createFlowEngine({ query, pool: {}, linePush: {}, buildLineMessages: () => ({ ok: true, messages: [] }) });
    await engine._processEnrollment({ id: 1, flow_id: 7, line_user_id: U('z'), current_node_key: 'n1', context: context || {} });
    return seen[0];
  }
  const bc = { mode: 'broadcast', broadcast_id: 90, c_key: null };
  assert.equal(await decide('a', bc), 'A');
  assert.equal(await decide('b', bc), 'B');
  const expect = half(7, U('z')) === 'a' ? 'A' : 'B';
  assert.equal(await decide('c', bc), expect, '收到 C 但沒有 C 路線');
  assert.equal(await decide(null, bc), expect, '沒收過群發');
  assert.equal(await decide('c', Object.assign({}, bc, { c_key: 'C' })), 'C', '有 C 路線就走 C');
  assert.equal(await decide('a', { mode: 'random' }), expect, '隨機模式不看群發');
  assert.equal(await decide('a', bc, { ab_variant: 'b' }), 'B', '已分過的版本沿用（重試、重複觸發不換版）');
});

// ------------------------------------------------------------- 匯出
test('匯出派送紀錄：日期必填且不可顛倒；CSV 欄位含版本、LINE 結果、有無點擊；不含測試發送', async () => {
  const routes = {}; let sqlSeen = '', params = null;
  registerAdminFlowsRoutes(makeApp(routes), { query: async (sql, p) => { sqlSeen = String(sql); params = p; return { rows: [
    { started_at: '2026-11-13T02:00:00Z', recipient_key: U('a'), variant: 'a', status: 'accepted', reason: null, message_snapshot: { mode: 'sequence', items: [{ type: 'text', text: 'STAGING A 版' }] }, tracked: true, clicked: true, display_name: 'STAGING a' },
    { started_at: '2026-11-13T03:00:00Z', recipient_key: U('b'), variant: null, status: 'rejected', reason: 'line_rate_limited', message_snapshot: {}, tracked: false, clicked: false, display_name: '名字,有逗號' }] }; },
    pool: {}, flowEngine: {}, authCore: { requireAdmin: (_q, _s, n) => n() } });
  const h = routes['GET /admin/flows/api/:id/sends.csv'];
  assert.equal((await run(h, { params: { id: '5' }, query: { from: '2026-11-13' } })).statusCode, 400);
  assert.equal((await run(h, { params: { id: '5' }, query: { from: '2026-11-14', to: '2026-11-13' } })).statusCode, 400);
  const res = await run(h, { params: { id: '5' }, query: { from: '2026-11-13', to: '2026-11-13' } });
  assert.match(sqlSeen, /NOT e\.test_only/);
  assert.match(sqlSeen, /e\.started_at >= \$2::timestamptz AND e\.started_at < \$3::timestamptz \+ INTERVAL '1 day'/);
  assert.deepEqual(params, [5, '2026-11-13T00:00:00+08:00', '2026-11-13T00:00:00+08:00']);
  const lines = res.body.replace(/^\ufeff/, '').split('\r\n');
  assert.equal(lines[0], '送出時間（台灣）,LINE 名稱,LINE User ID,版本,訊息,LINE 結果,原因,有無點擊');
  assert.equal(lines[1], '2026-11-13 10:00:00,STAGING a,' + U('a') + ',A 版,STAGING A 版,LINE 已接受,,有');
  assert.equal(lines[2], '2026-11-13 11:00:00,"名字,有逗號",' + U('b') + ',—,,LINE 拒絕,line_rate_limited,—');
  assert.match(res.headers['Content-Disposition'], /flow-5-sends-2026-11-13_2026-11-13\.csv/);
});

// ------------------------------------------------------------- 圖文選單期間
test('圖文選單成效：可選期間（台灣時間含起訖），不帶就是全部；期間格式錯誤擋下', async () => {
  const routes = {}; const calls = [];
  registerAdminRichMenuRoutes(makeApp(routes), { query: async (sql, p) => { calls.push({ sql: String(sql), p }); return { rows: [] }; }, authCore: { requireAdmin: (_q, _s, n) => n() } });
  const h = routes['GET /admin/richmenu/api/stats'];
  const all = await run(h, { query: { id: '9' } });
  assert.equal(all.body.range, null);
  assert.doesNotMatch(calls[0].sql, /created_at >= \$2/);
  calls.length = 0;
  const r = await run(h, { query: { id: '9', from: '2026-11-03', to: '2026-11-09' } });
  assert.deepEqual(r.body.range, { from: '2026-11-03', to: '2026-11-09' });
  assert.match(calls[0].sql, /AND created_at >= \$2::timestamptz AND created_at < \$3::timestamptz \+ interval '1 day'/);
  assert.deepEqual(calls[0].p, [9, '2026-11-03T00:00:00+08:00', '2026-11-09T00:00:00+08:00']);
  assert.equal((await run(h, { query: { id: '9', from: '2026-11-09', to: '2026-11-03' } })).statusCode, 400);
});

// ------------------------------------------------------------- 畫面
test('流程編輯器：有「A/B 分組」與「進入條件」；名單與流程共用條件編輯器（含條件組）', async () => {
  const flows = fs.readFileSync(path.join(REPO, 'views/admin_flows.ejs'), 'utf8');
  assert.match(flows, /data-add="ab_split">＋ A\/B 分組/);
  assert.match(flows, /沿用群發的版本/);
  assert.match(flows, /直接隨機（A、B 各 50%）/);
  assert.match(flows, /id="fl-entry"/);
  assert.match(flows, /\/audience-builder\.js/);
  assert.match(flows, /\/sends\.csv\?from=/);
  const lists = fs.readFileSync(path.join(REPO, 'views/admin_recipient_lists.ejs'), 'utf8');
  assert.match(lists, /id="aud-add-group"/);
  assert.match(lists, /\/audience-builder\.js/);
  // 共用編輯器：組出含條件組的定義
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="c"></div>', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(REPO, 'public/audience-builder.js'), 'utf8'));
  const b = dom.window.AudienceBuilder.create({ container: dom.window.document.getElementById('c'), getCatalog: () => ({ tags: [{ id: 3, name: 'VIP' }] }) });
  b.addCondition({ mode: 'include', type: 'is_friend' });
  const g = b.addGroup({ type: 'group', mode: 'include', operator: 'or', conditions: [{ mode: 'include', type: 'tag', value: 3 }, { mode: 'exclude', type: 'is_blocked' }] });
  const def = b.definition('and');
  assert.deepEqual(JSON.parse(JSON.stringify(def)), { operator: 'and', conditions: [{ mode: 'include', type: 'is_friend', value: null },
    { type: 'group', mode: 'include', operator: 'or', conditions: [{ mode: 'include', type: 'tag', value: '3' }, { mode: 'exclude', type: 'is_blocked', value: null }] }] });
  assert.equal(b.count(), 3);
  b.load(def);
  assert.equal(dom.window.document.querySelectorAll('.aud-group').length, 1, '讀回時還原條件組');
  dom.window.close();
});

test('A/B 分組：查詢群發版本失敗時不改用 50/50、不寫入分組、不發送，排重試；恢復後沿用真正的版本', async () => {
  const node = { node_key: 'n1', type: 'ab_split', config: { mode: 'broadcast', broadcast_id: 90, c_key: null }, branch_true_key: 'A', branch_false_key: 'B' };
  let failLookup = true;
  const writes = [];
  const reached = [];
  const query = async (sql, p) => {
    const s = String(sql);
    if (/FROM admin_flow_nodes WHERE flow_id = \$1 AND node_key = \$2/.test(s)) {
      if (p[1] === 'n1') return { rows: [node], rowCount: 1 };
      reached.push(p[1]); return { rows: [{ node_key: p[1], type: 'end' }], rowCount: 1 };
    }
    if (/FROM admin_broadcast_recipients/.test(s)) {
      if (failLookup) throw new Error('connection terminated');
      return { rows: [{ variant: 'a' }], rowCount: 1 };
    }
    if (/UPDATE admin_flow_enrollments/.test(s)) writes.push({ sql: s.replace(/\s+/g, ' '), p });
    return { rows: [], rowCount: 0 };
  };
  const engine = createFlowEngine({ query, pool: {}, linePush: {}, buildLineMessages: () => ({ ok: true, messages: [] }) });
  const en = { id: 1, flow_id: 7, line_user_id: U('a'), current_node_key: 'n1', retry_count: 0, context: {} };
  await engine._processEnrollment(Object.assign({}, en));
  assert.deepEqual(reached, [], '查詢失敗：A、B 路線都沒走');
  assert.equal(writes.some(w => /context = COALESCE\(context/.test(w.sql)), false, '查詢失敗：沒有寫入分組結果');
  const retry = writes.find(w => /SET retry_count = \$2, last_error = \$3, next_run_at = \$4/.test(w.sql));
  assert.ok(retry, '排重試');
  assert.equal(retry.p[2], 'ab_split_broadcast_lookup_failed');
  failLookup = false; writes.length = 0;
  await engine._processEnrollment(Object.assign({}, en, { retry_count: 1 }));
  assert.deepEqual(reached, ['A'], '恢復後沿用群發收到的 A 版');
  assert.equal(JSON.parse(writes.find(w => /context = COALESCE\(context/.test(w.sql)).p[1]).ab_variant, 'a');
});
