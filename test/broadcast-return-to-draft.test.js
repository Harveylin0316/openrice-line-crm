'use strict';
// 排程中的群發「退回草稿」：停止排程（不送出）並把所有設定帶回群發頁，改完重新預覽、排程。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const { buildDraftFromBroadcast } = require('../src/core/broadcastDraft');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const FUTURE = new Date(Date.now() + 3 * 86400000);
FUTURE.setUTCSeconds(0, 0);
const tpl = (title, cta) => ({ mode: 'template', template: { heroMediaId: null, title, subtitle: '副標', couponCode: '', disclaimer: '', ctaLabel: '去看看', ctaUrl: cta, altText: title } });

function row(over) {
  return Object.assign({
    id: 31, status: 'scheduled', channel: 'line', scheduled_at: FUTURE.toISOString(),
    message_config: tpl('A 版標題', 'https://example.com/a'),
    is_ab_test: true, variant_b_message_config: tpl('B 版標題', 'https://example.com/b'),
    audience_config: {
      conditions: { excludeBroadcastIds: [29], allMembers: false, joinedWithinDays: 30, lifecycleStages: ['active', 'sleeping'],
        playedLiffWithinDays: 14, bookingSource: null, savedListId: null, lineUserIds: null },
      recipientSelection: { mode: 'random', count: 423, eligibleTotal: 900, sendTotal: 423 },
      messageSource: { id: 8, name: '11 月訂位活動' }
    }
  }, over || {});
}

test('退回草稿內容：帶回訊息、A/B、條件、抽樣、來源；原排程時間未到才帶回', () => {
  const d = buildDraftFromBroadcast(row());
  assert.equal(d.broadcastId, 31);
  assert.equal(d.message_config.template.title, 'A 版標題');
  assert.equal(d.is_ab_test, true);
  assert.equal(d.variant_b_message_config.template.title, 'B 版標題');
  assert.deepEqual(d.conditions.excludeBroadcastIds, [29]);
  assert.deepEqual(d.recipientSelection, { mode: 'random', count: 423 });
  assert.deepEqual(d.messageSource, { id: 8, name: '11 月訂位活動' });
  const tw = FUTURE.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0, 16);
  assert.equal(d.scheduledAt, tw, '台灣時間到分鐘');
  const past = buildDraftFromBroadcast(row({ scheduled_at: new Date(Date.now() - 60000).toISOString() }));
  assert.equal(past.scheduledAt, null, '已過的時間不帶回');
  assert.ok(past.originalScheduledAt);
  const ex = buildDraftFromBroadcast(row({ audience_config: { conditions: {}, experiment: { enabled: true, variantCount: 3, winnerMode: 'auto', observationHours: 12,
    allocations: { a: 20, b: 20, c: 20, holdout: 40 }, variantCMessageConfig: tpl('C', 'https://example.com/c') } } }));
  assert.equal(ex.is_ab_test, false, 'Campaign Testing 不當成一般 A/B');
  assert.equal(ex.experiment.variantCount, 3);
  assert.equal(ex.experiment.variantCMessageConfig.template.title, 'C');
});

function buildRoutes(db) {
  const routes = {};
  const app = {
    get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; },
    delete(p, ...h) { routes['DELETE ' + p] = h; }, put(p, ...h) { routes['PUT ' + p] = h; }
  };
  const pass = (_q, _r, next) => next();
  const client = { query: async (sql, params) => db(sql, params), release() {} };
  registerAdminBroadcastRoutes(app, {
    query: async (sql, params) => db(sql, params), pool: { connect: async () => client },
    authCore: { requireAdmin: pass }, linePush: {}, emailProvider: { isConfigured: () => false },
    lineChannelAccessToken: 'token', resolvePublicSiteOrigin: () => 'https://example.netlify.app'
  });
  return routes;
}
async function run(handlers, id) {
  const req = { body: {}, params: { id: String(id) }, query: {}, authUser: { un: 'ice' }, get: () => 'x' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  for (const h of handlers) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}

test('退回草稿 API：只有排程中能退回，收件人一起取消、記錄誰退回；已開始送就擋下', async () => {
  const sqls = [];
  let status = 'scheduled';
  const routes = buildRoutes(async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ');
    sqls.push({ s, params });
    if (/UPDATE admin_broadcasts SET status = 'cancelled'/.test(s)) {
      assert.match(s, /WHERE id = \$1 AND status = 'scheduled'/);
      if (status !== 'scheduled') return { rows: [], rowCount: 0 };
      status = 'cancelled';
      return { rows: [row({ status: 'cancelled' })], rowCount: 1 };
    }
    if (/SELECT status FROM admin_broadcasts/.test(s)) return { rows: [{ status }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const h = routes['POST /admin/broadcast/:id(\\d+)/return-to-draft'];
  const ok = await run(h, 31);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.draft.variant_b_message_config.template.title, 'B 版標題');
  assert.equal(sqls.find(x => /UPDATE admin_broadcasts/.test(x.s)).params[1], 'ice');
  assert.ok(sqls.some(x => /UPDATE admin_broadcast_recipients SET status = 'cancelled', error = COALESCE\(error, 'returned_to_draft'\)/.test(x.s)));
  assert.deepEqual(sqls.filter(x => /^(BEGIN|COMMIT|ROLLBACK)$/.test(x.s)).map(x => x.s), ['BEGIN', 'COMMIT']);

  status = 'running';
  const late = await run(h, 31);
  assert.equal(late.statusCode, 409);
  assert.equal(late.body.error, 'not_scheduled');
  assert.match(late.body.detail, /已經開始發送/);
});

test('草稿載入只接受「退回草稿」停止的批次：排程中、發送中、已完成、一般取消、等待勝出都拒絕', async () => {
  let current;
  const routes = buildRoutes(async (sql) => {
    if (/SELECT \* FROM admin_broadcasts WHERE id = \$1/.test(String(sql))) return current ? { rows: [current], rowCount: 1 } : { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  const h = routes['GET /admin/broadcast/:id(\\d+)/draft-config'];
  const returned = { returnedToDraft: { at: '2026-11-17T02:00:00Z', by: 'ice' } };
  const cases = [
    ['scheduled', {}], ['running', {}], ['done', {}], ['awaiting_winner', {}], ['winner_released', {}],
    ['cancelled', {}],                       // 一般取消（沒有退回草稿標記）
    ['running', returned], ['done', returned] // 標記存在但狀態不是 cancelled 也不行
  ];
  for (const [status, extra] of cases) {
    const base = row();
    current = Object.assign(base, { status, audience_config: Object.assign({}, base.audience_config, extra) });
    const res = await run(h, 31);
    assert.equal(res.statusCode, 409, status + (extra.returnedToDraft ? '（有標記）' : '') + ' 要被拒絕');
    assert.equal(res.body.error, 'not_returned_to_draft');
    assert.equal(res.body.draft, undefined, '不能回傳設定');
  }
  const ok = row();
  current = Object.assign(ok, { status: 'cancelled', audience_config: Object.assign({}, ok.audience_config, returned) });
  const res = await run(h, 31);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.draft.broadcastId, 31);
  current = null;
  assert.equal((await run(h, 99)).statusCode, 404);
});

test('群發頁 ?restore= 遇到非退回草稿的批次：顯示原因，不帶回設定、不顯示「已停止」提示', async () => {
  const draft = buildDraftFromBroadcast(row());
  const { dom, doc, alerts } = await openPage('https://crm.example/admin/broadcast?restore=31', draft,
    { ok: false, error: 'not_returned_to_draft', detail: '這個批次不是透過「退回草稿」停止的，無法帶回草稿。' });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /不是透過「退回草稿」停止/);
  assert.equal(doc.getElementById('restore-notice').hidden, true, '不能顯示「原排程已停止、不會送出」');
  assert.notEqual(doc.getElementById('tpl-title').value, 'A 版標題', '不帶回任何設定');
  dom.window.close();
});

async function openPage(url, draft, draftResponse) {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發訊息', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], hasLineToken: true, gamesLiffId: 'LIFF', prefillActivityId: null,
    prefillListId: null, maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false,
    scheduled: [{ id: 31, scheduled_at: FUTURE.toISOString(), recipient_total: 423 }], running: []
  }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  const alerts = [];
  w.alert = (m) => { if (!draftResponse) throw new Error('unexpected alert: ' + m); alerts.push(String(m)); };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = [];
  w.fetch = async (u, opts) => {
    calls.push({ u: String(u), method: (opts && opts.method) || 'GET' });
    if (/\/draft-config$/.test(u)) return { json: async () => (draftResponse || { ok: true, draft }) };
    if (/\/return-to-draft$/.test(u)) return { json: async () => ({ ok: true, draft }) };
    if (u === '/admin/broadcast/templates') return { json: async () => ({ ok: true, templates: [] }) };
    return { json: async () => ({ ok: true, recipients: [], lists: [], sources: [] }) };
  };
  w.eval(fs.readFileSync(path.join(REPO, 'public/crm-confirm.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(REPO, 'public/admin-broadcast.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(REPO, 'public/broadcast-return-draft.js'), 'utf8'));
  await wait(60);
  return { dom, w, doc: w.document, calls, alerts };
}

test('群發頁 ?restore=：A/B 兩版、條件、排除、抽樣、排程時間都帶回，需重新預覽才能送', async () => {
  const draft = buildDraftFromBroadcast(row());
  const { dom, w, doc } = await openPage('https://crm.example/admin/broadcast?restore=31', draft);
  const v = id => doc.getElementById(id).value;
  assert.equal(v('tpl-title'), 'A 版標題');
  assert.equal(v('tpl-cta-url'), 'https://example.com/a');
  assert.equal(doc.getElementById('ab-test-enable').checked, true);
  assert.equal(v('b-tpl-title'), 'B 版標題');
  assert.equal(v('b-tpl-cta-url'), 'https://example.com/b');
  assert.equal(v('joined-within'), '30');
  assert.deepEqual([...doc.querySelectorAll('input[name="lifecycle_stage"]:checked')].map(e => e.value), ['active', 'sleeping']);
  assert.equal(v('liff-played-days'), '14');
  assert.equal(v('exclude-broadcast-ids'), '29');
  assert.equal(v('recipient-selection-mode'), 'random');
  assert.equal(v('recipient-selection-count'), '423');
  assert.equal(doc.querySelector('input[name="send-mode"][value="scheduled"]').checked, true);
  assert.equal(v('schedule-datetime'), draft.scheduledAt);
  assert.match(doc.getElementById('audience-status').textContent, /已帶回 #31 的設定.*重新預覽收件人/);
  assert.equal(doc.getElementById('restore-notice').hidden, false, '頁面最上方看得到已帶回的提示');
  assert.match(doc.getElementById('restore-notice').textContent, /不會送出.*重新預覽/);
  assert.ok(doc.getElementById('btn-send').classList.contains('btn-needs-prep'), '還沒重新預覽前不能送出');
  dom.window.close();
});

test('多段訊息的 A/B：B 版逐段內容原樣帶回，不被 A 版覆蓋', async () => {
  const seqA = { mode: 'sequence', items: [{ type: 'text', text: 'A 版文字' }] };
  const seqB = { mode: 'sequence', items: [{ type: 'text', text: 'B 版文字（改過）' }] };
  const draft = buildDraftFromBroadcast(row({ message_config: seqA, variant_b_message_config: seqB }));
  const { dom, w } = await openPage('https://crm.example/admin/broadcast?restore=31', draft);
  const saved = JSON.parse(w.localStorage.getItem('broadcast_draft_v1'));
  assert.deepEqual(saved.sequenceConfig, seqA);
  assert.deepEqual(saved.seqVariants.b, seqB);
  dom.window.close();
});

test('排程列表的「退回草稿」：確認後呼叫 API 並帶到 ?restore=', async () => {
  const draft = buildDraftFromBroadcast(row());
  const { dom, w, doc, calls } = await openPage('https://crm.example/admin/broadcast', draft);
  const btn = doc.querySelector('.sched-draft-btn[data-id="31"]');
  assert.ok(btn, '排程列表要有退回草稿按鈕');
  let went = null;
  w.crmNavigate = (to) => { went = to; }; // jsdom 不支援導頁
  btn.click();
  await wait(10);
  const yes = doc.querySelector('.crm-confirm-yes');
  assert.ok(yes, '要先確認');
  assert.match(doc.querySelector('.crm-confirm-overlay').textContent, /不會送出/);
  yes.click();
  await wait(30);
  assert.ok(calls.some(c => c.u === '/admin/broadcast/31/return-to-draft' && c.method === 'POST'));
  assert.equal(went, '/admin/broadcast?restore=31');
  dom.window.close();
});
