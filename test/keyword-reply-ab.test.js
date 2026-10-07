'use strict';
// 關鍵字回覆 A/B 測試：分組、回覆、重送、點擊歸因、報表、後台設定與畫面
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const ke = require('../src/core/keywordExperiments');
const { compareSummaries } = require('../src/routes/adminKeywordExperiments');
const { summarizeConfig } = require('../src/core/broadcastMessageSnapshot');
const { createLineWebhookHandler } = require('../src/routes/lineWebhook');

const REPO = path.join(__dirname, '..');
const U = c => 'U' + c.repeat(32);
const SECRET = 'STAGING_TEST_SECRET';
const wait = ms => new Promise(r => setTimeout(r, ms));

function rewardCard(img, url) {
  return { mode: 'sequence', items: [
    { type: 'text', text: 'STAGING 更改訂位步驟' },
    { type: 'card', message_config: { mode: 'flex_json', flex: { type: 'flex', altText: '獎勵', contents: { type: 'bubble',
      hero: { type: 'image', url: img, size: 'full' },
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '完成更改送獎勵' }] },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label: '領獎勵', uri: url } }] } } } } }
  ] };
}
const CFG_A = rewardCard('https://img.example/a.jpg', 'https://example.com/reward');
const CFG_B = rewardCard('https://img.example/b.jpg', 'https://example.com/reward');
const IMAGEMAP = { mode: 'imagemap', imagemap: { assetId: '3f2b6a1e-9c4d-4e8f-a1b2-c3d4e5f60718', baseWidth: 1040, baseHeight: 1040, altText: 'STAGING 滿版', layout: 'top_bottom',
  areas: [{ x: 0, y: 0, width: 1040, height: 520, type: 'uri', uri: 'https://example.com/top' }, { x: 0, y: 520, width: 1040, height: 520, type: 'message', text: '我要更改' }] } };
const TEXT_ONLY = { mode: 'sequence', items: [{ type: 'text', text: 'STAGING 純文字 https://example.com/plain' }] };

function exp(over) {
  const now = Date.now();
  return Object.assign({
    id: 11, rule_id: 7, name: 'STAGING 封面', status: 'running',
    start_at: new Date(now - 3600e3).toISOString(), end_at: new Date(now + 7 * 86400e3).toISOString(),
    fallback_variant: 'a', attribution_days: 7, variant_a_config: CFG_A, variant_b_config: CFG_B,
    variant_a_name: 'STAGING A', variant_b_name: 'STAGING B',
    targets: { a: [{ index: 0, label: '領獎勵', uri: 'https://example.com/reward' }], b: [{ index: 0, label: '領獎勵', uri: 'https://example.com/reward' }], primary: { a: [0], b: [0] } }
  }, over || {});
}

// ---------------------------------------------------------------- 狀態與回覆決策
test('回覆決策：尚未開始／沒有實驗→原本規則；進行中→實驗；沒有用戶身分→原本規則；暫停／到期→固定版本', () => {
  const now = new Date();
  assert.equal(ke.decideReply(null, { lineUserId: U('a') }).mode, 'original');
  assert.equal(ke.decideReply(exp({ start_at: new Date(Date.now() + 3600e3).toISOString() }), { lineUserId: U('a') }).mode, 'original');
  assert.equal(ke.decideReply(exp(), { lineUserId: U('a') }).mode, 'experiment');
  assert.equal(ke.decideReply(exp(), { lineUserId: null }).mode, 'original');
  assert.equal(ke.decideReply(exp(), { lineUserId: 'not-a-line-id' }).mode, 'original');
  const paused = ke.decideReply(exp({ status: 'paused', fallback_variant: 'b' }), { lineUserId: U('a') });
  assert.deepEqual([paused.mode, paused.variant], ['fallback', 'b']);
  const expired = ke.decideReply(exp({ end_at: new Date(Date.now() - 1000).toISOString() }), { lineUserId: U('a'), now });
  assert.deepEqual([expired.mode, expired.variant, expired.state], ['fallback', 'a', 'ended']);
  assert.equal(ke.effectiveState({ status: 'weird', start_at: now, end_at: now }), 'none');
  assert.equal(ke.effectiveState(exp({ start_at: null })), 'none');
});

test('分組：第一次隨機、之後固定；重複分組只會有一筆新分組', async () => {
  const store = new Map();
  const q = async (sql, p) => {
    if (/INSERT INTO keyword_reply_experiment_assignments/.test(sql)) {
      const k = p[0] + ':' + p[1];
      if (store.has(k)) return { rows: [] };
      store.set(k, p[2]); return { rows: [{ variant: p[2] }] };
    }
    if (/SELECT variant FROM keyword_reply_experiment_assignments/.test(sql)) return { rows: [{ variant: store.get(p[0] + ':' + p[1]) }] };
    return { rows: [] };
  };
  const first = await ke.assignVariant(q, 11, U('a'), () => 1);
  assert.deepEqual(first, { variant: 'b', isNew: true });
  const again = await ke.assignVariant(q, 11, U('a'), () => 0);
  assert.deepEqual(again, { variant: 'b', isNew: false }, '第二次不重新抽組');
});

// ---------------------------------------------------------------- 訊息組裝與追蹤連結
test('追蹤連結：所有可追蹤的開啟網址（含滿版圖文點擊區）換成只帶隨機代碼的跳板，不含 LINE User ID', () => {
  const code = 'STAGINGcode1234567890ab';
  const seq = ke.buildExperimentMessages(CFG_B, { origin: 'https://crm.example', deliveryCode: code, liffId: 'L-1' });
  assert.equal(seq.ok, true);
  assert.deepEqual(seq.messages.map(m => m.type), ['text', 'flex'], '多段訊息順序不變');
  assert.equal(seq.messages[1].contents.footer.contents[0].action.uri, 'https://liff.line.me/L-1/t/x/' + code + '_0');
  assert.doesNotMatch(JSON.stringify(seq.messages), /U[0-9a-f]{32}/);
  const im = ke.buildExperimentMessages(IMAGEMAP, { origin: 'https://crm.example', deliveryCode: code, liffId: 'L-1' });
  assert.equal(im.messages[0].type, 'imagemap');
  assert.equal(im.messages[0].actions[0].linkUri, 'https://liff.line.me/L-1/t/x/' + code + '_0');
  assert.equal(im.messages[0].actions[1].type, 'message', '傳送文字動作保留、不追蹤');
  // 沒有 LIFF：照常回覆，但不追蹤
  const noLiff = ke.buildExperimentMessages(CFG_B, { origin: 'https://crm.example', deliveryCode: code, liffId: '' });
  assert.equal(noLiff.messages[1].contents.footer.contents[0].action.uri, 'https://example.com/reward');
  // 純文字網址現在也可追蹤；滿版圖文仍只算 URI 區域
  assert.deepEqual(ke.trackableTargets(TEXT_ONLY, 'https://crm.example').map(t=>t.uri), ['https://example.com/plain']);
  assert.deepEqual(ke.trackableTargets(IMAGEMAP, 'https://crm.example').map(t => t.uri), ['https://example.com/top']);
});

// ---------------------------------------------------------------- 點擊歸因
test('點擊：依代碼導向快照目的地；只記「點擊者就是收件人」且已驗證身分的點擊', async () => {
  const inserts = [];
  const q = async (sql, p) => {
    if (/FROM keyword_reply_experiment_deliveries d/.test(sql)) {
      return p[0] === 'STAGINGcode1234567890ab'
        ? { rows: [{ id: 99, experiment_id: 11, line_user_id: U('b'), variant: 'b', targets: exp().targets }] }
        : { rows: [] };
    }
    if (/INSERT INTO keyword_reply_experiment_clicks/.test(sql)) { inserts.push(p); return { rows: [] }; }
    return { rows: [] };
  };
  const hit = await ke.resolveClick(q, 'STAGINGcode1234567890ab_0');
  assert.equal(hit.uri, 'https://example.com/reward');
  assert.equal(await ke.resolveClick(q, 'STAGINGcode1234567890ab_5'), null, '不存在的目標不導向');
  assert.equal(await ke.resolveClick(q, 'bad'), null);
  assert.equal(await ke.resolveClick(q, 'unknownCode1234567890_0'), null);
  assert.equal((await ke.recordVerifiedClick(q, hit, U('e'))).reason, 'not_recipient', '轉傳後別人點的不算');
  assert.equal((await ke.recordVerifiedClick(q, hit, null)).reason, 'unverified');
  assert.equal((await ke.recordVerifiedClick(q, hit, U('b'))).recorded, true);
  assert.deepEqual(inserts, [[99, 11, 'b', U('b'), 0]]);
});

test('點擊跳板路由：導向快照目的地；沒有 LINE 身分憑證就不記點擊', async () => {
  const { registerAdminKeywordExperimentRoutes } = require('../src/routes/adminKeywordExperiments');
  const routes = {};
  const app = { get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; } };
  const inserts = [];
  registerAdminKeywordExperimentRoutes(app, {
    query: async (sql, p) => {
      if (/FROM keyword_reply_experiment_deliveries d/.test(sql)) return { rows: [{ id: 99, experiment_id: 11, line_user_id: U('b'), variant: 'b', targets: exp().targets }] };
      if (/INSERT INTO keyword_reply_experiment_clicks/.test(sql)) inserts.push(p);
      return { rows: [] };
    },
    authCore: { requireAdmin: (_q, _s, n) => n() }, liffIdForTracking: () => '2007974193-STAGING'
  });
  let rendered = null;
  const res = { setHeader() {}, render(v, d) { rendered = { v, d }; return this; }, redirect(u) { this.redirected = u; return this; } };
  await routes['GET /t/x/:code([A-Za-z0-9_-]+)'][0]({ params: { code: 'STAGINGcode1234567890ab_0' } }, res);
  assert.equal(rendered.v, 'tap_bounce');
  assert.equal(rendered.d.target, 'https://example.com/reward');
  assert.equal(rendered.d.recordUrl, '/t/x/STAGINGcode1234567890ab_0/hit');
  assert.ok(routes['GET /games/t/x/:code([A-Za-z0-9_-]+)'], 'LIFF 端點路徑也要有');
  const out = { json(b) { this.body = b; return this; } };
  await routes['POST /t/x/:code([A-Za-z0-9_-]+)/hit'][0]({ params: { code: 'STAGINGcode1234567890ab_0' }, body: { id_token: '' } }, out);
  assert.deepEqual(out.body, { ok: true, recorded: false });
  assert.equal(inserts.length, 0);
});

// ---------------------------------------------------------------- 報表口徑
test('報表：沒有可追蹤目標顯示不適用（null）、不給差距；有目標才比較', async () => {
  const q = async () => ({ rows: [{ triggers: 5, assigned_users: 4, replies_ok: 4, reply_users: 3, replies_failed: 1, replies_uncertain: 0,
    target_clicks: 2, clickers: 1, matured_users: 2, matured_clickers: 1 }] });
  const noTarget = await ke.experimentReport(q, exp({ targets: { a: [], b: exp().targets.b, primary: { a: [], b: [0] } } }));
  assert.equal(noTarget.variants.a.trackable, false);
  assert.equal(noTarget.variants.a.ctr_matured, null);
  assert.equal(noTarget.variants.a.target_clicks, null);
  assert.equal(noTarget.comparable, false, '一版不可比較就不能說另一版比較好');
  assert.equal(noTarget.diff_pp_matured, null);
  const both = await ke.experimentReport(q, exp());
  assert.equal(both.variants.a.ctr_observing, 33.3);
  assert.equal(both.variants.a.ctr_matured, 50);
  assert.equal(both.comparable, true);
  assert.equal(both.diff_pp_matured, 0);
  const empty = await ke.experimentReport(async () => ({ rows: [{}] }), exp());
  assert.equal(empty.variants.a.ctr_observing, null, '分母 0 → 尚無資料（null），不是 0%');
});

test('差異比對：只有圖片不同才標示「適合測封面」', () => {
  const sA = summarizeConfig(CFG_A, { origin: 'https://crm.example' });
  const sB = summarizeConfig(CFG_B, { origin: 'https://crm.example' });
  assert.deepEqual(compareSummaries(sA, sB), { differs: ['圖片'], onlyImages: true });
  const other = rewardCard('https://img.example/b.jpg', 'https://example.com/OTHER');
  const c = compareSummaries(sA, summarizeConfig(other, { origin: 'https://crm.example' }));
  assert.equal(c.onlyImages, false);
  assert.ok(c.differs.includes('按鈕／連結'));
  assert.ok(compareSummaries(sA, summarizeConfig(IMAGEMAP, { origin: 'https://crm.example' })).differs.includes('訊息格式／段落'));
  // 卡片標題（第一行）不同也要算「文字不同」，不能誤判成只換封面
  const titled = JSON.parse(JSON.stringify(CFG_B));
  titled.items[1].message_config.flex.contents.body.contents[0].text = '另一個標題';
  const t = compareSummaries(sA, summarizeConfig(titled, { origin: 'https://crm.example' }));
  assert.equal(t.onlyImages, false);
  assert.ok(t.differs.includes('文字'));
});

// ---------------------------------------------------------------- 回覆結果三分類
test('Reply API 結果：2xx＝成功、4xx＝失敗、逾時／網路中斷＝不確定（不重送）', async () => {
  const { createLinePushService } = require('../src/core/linePush');
  const logs = [];
  const prevFetch = global.fetch;
  try {
    const svc = createLinePushService({ query: async (s, p) => { logs.push(p); return { rows: [] }; }, lineChannelAccessToken: 'STAGING' });
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, status: 200, text: async () => '' }; };
    assert.deepEqual(await svc.replyLineMessagesDetailed('TOKEN', [{ type: 'text', text: 'hi' }]), { status: 'accepted', httpStatus: 200 });
    global.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'Invalid reply token' }; };
    const rej = await svc.replyLineMessagesDetailed('TOKEN', [{ type: 'text', text: 'hi' }]);
    assert.equal(rej.status, 'rejected');
    assert.equal(rej.httpStatus, 400);
    global.fetch = async () => { calls++; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    const unc = await svc.replyLineMessagesDetailed('TOKEN', [{ type: 'text', text: 'hi' }]);
    assert.equal(unc.status, 'uncertain');
    assert.equal(calls, 3, '每次只呼叫一次，不自動重送');
    assert.equal((await svc.replyLineMessagesDetailed('', [{ type: 'text', text: 'hi' }])).status, 'rejected');
  } finally { global.fetch = prevFetch; }
});

// ---------------------------------------------------------------- webhook 整合
function webhookHarness({ experiment = exp(), assignVariant = 'b', replyStatus = 'accepted', lookupFails = false, realSender = false } = {}) {
  const state = { assignments: new Map(), deliveries: [], finished: [], replies: [], hit: 0, events: new Set() };
  const pool = {
    query: async (sql, p = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('FROM admin_keyword_replies') && s.includes('match_type')) return { rowCount: 1, rows: [{ id: 7, keywords: '透過 OpenRice 訂位', match_type: 'exact', message_template_id: 8 }] };
      if (s.includes('SELECT message_config FROM admin_message_templates')) return { rowCount: 1, rows: [{ message_config: { mode: 'sequence', items: [{ type: 'text', text: 'STAGING 原本回覆' }] } }] };
      if (s.includes('FROM keyword_reply_experiments WHERE rule_id')) {
        if (lookupFails) throw new Error('relation "keyword_reply_experiments" does not exist');
        return { rows: experiment ? [experiment] : [] };
      }
      if (s.includes('INSERT INTO keyword_reply_experiment_assignments')) {
        const k = p[1];
        if (state.assignments.has(k)) return { rows: [] };
        state.assignments.set(k, assignVariant); return { rows: [{ variant: assignVariant }] };
      }
      if (s.includes('SELECT variant FROM keyword_reply_experiment_assignments')) return { rows: [{ variant: state.assignments.get(p[1]) }] };
      if (s.includes('INSERT INTO keyword_reply_experiment_deliveries')) {
        if (p[3] && state.events.has(p[3])) return { rows: [] };
        if (p[3]) state.events.add(p[3]);
        const row = { id: state.deliveries.length + 1, delivery_code: p[4] };
        state.deliveries.push({ ...row, variant: p[2], user: p[1] });
        return { rows: [row] };
      }
      if (s.includes('UPDATE keyword_reply_experiment_deliveries')) { state.finished.push(p[1]); return { rows: [] }; }
      if (s.includes('UPDATE admin_keyword_replies SET hit_count')) { state.hit++; return { rows: [] }; }
      return { rowCount: 0, rows: [] };
    }
  };
  const linePush = realSender ? require('../src/core/linePush').createLinePushService({
    query: pool.query, lineChannelAccessToken: 'SYNTHETIC_NOT_A_REAL_TOKEN'
  }) : {
    replyLineMessages: async (token, messages) => { state.replies.push({ token, messages, path: 'plain' }); return true; },
    replyLineMessagesDetailed: async (token, messages) => { state.replies.push({ token, messages, path: 'detailed' }); return { status: replyStatus, httpStatus: replyStatus === 'accepted' ? 200 : null }; }
  };
  const handler = createLineWebhookHandler({ pool, channelSecret: SECRET, linePush });
  const send = async (events) => {
    const body = Buffer.from(JSON.stringify({ events }));
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
    const res = { status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
    await handler({ body, get: () => sig }, res);
    return res;
  };
  return { state, send };
}
const textEvent = (eventId, userId = U('b'), sourceType = 'user') => ({
  type: 'message', webhookEventId: eventId, replyToken: 'REPLY_' + eventId,
  source: Object.assign({ type: sourceType }, userId ? { userId } : {}), message: { type: 'text', text: '透過 OpenRice 訂位' }
});

test('webhook A/B with the real sender preserves text+imagemap and only replies once on event redelivery', async () => {
  const previousFetch = global.fetch;
  const previousOrigin = process.env.LINE_PUSH_PUBLIC_BASE_URL;
  const previousLiff = process.env.GAMES_LIFF_ID;
  process.env.LINE_PUSH_PUBLIC_BASE_URL = 'https://staging.example';
  process.env.GAMES_LIFF_ID = 'L-SYNTHETIC';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };
  try {
    const config = { mode: 'sequence', items: [{ type: 'text', text: 'SYNTHETIC intro' },
      { type: 'card', message_config: IMAGEMAP }] };
    const h = webhookHarness({ realSender: true, experiment: exp({ variant_a_config: config, variant_b_config: config, targets:{a:ke.trackableTargets(config),b:ke.trackableTargets(config),primary:{a:[0],b:[0]}} }) });
    await h.send([textEvent('SYNTHETIC-MAP-1')]);
    await h.send([textEvent('SYNTHETIC-MAP-1')]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.line.me/v2/bot/message/reply');
    assert.deepEqual(requests[0].body.messages.map(m => m.type), ['text', 'imagemap']);
    assert.match(requests[0].body.messages[1].actions[0].linkUri, /^https:\/\/liff\.line\.me\/L-SYNTHETIC\/t\/x\/[A-Za-z0-9_-]+_0$/);
    assert.equal(requests[0].body.messages[1].actions[1].text, '我要更改');
    assert.deepEqual(h.state.finished, ['accepted']);
    assert.equal(h.state.deliveries.length, 1);
  } finally {
    global.fetch = previousFetch;
    if (previousOrigin === undefined) delete process.env.LINE_PUSH_PUBLIC_BASE_URL; else process.env.LINE_PUSH_PUBLIC_BASE_URL = previousOrigin;
    if (previousLiff === undefined) delete process.env.GAMES_LIFF_ID; else process.env.GAMES_LIFF_ID = previousLiff;
  }
});

test('webhook：實驗中依分組回覆 B 版（連結已換成跳板），結果寫回並計入命中', async () => {
  const prev = process.env.LINE_PUSH_PUBLIC_BASE_URL; const prevLiff = process.env.GAMES_LIFF_ID;
  process.env.LINE_PUSH_PUBLIC_BASE_URL = 'https://staging.example'; process.env.GAMES_LIFF_ID = 'L-STAGING';
  try {
    const h = webhookHarness();
    await h.send([textEvent('EV-1')]);
    assert.equal(h.state.replies.length, 1);
    const r = h.state.replies[0];
    assert.equal(r.path, 'detailed');
    assert.equal(r.token, 'REPLY_EV-1');
    assert.deepEqual(r.messages.map(m => m.type), ['text', 'flex']);
    assert.equal(r.messages[1].contents.hero.url, 'https://img.example/b.jpg', 'B 版封面');
    assert.match(r.messages[1].contents.footer.contents[0].action.uri, /^https:\/\/liff\.line\.me\/L-STAGING\/t\/x\/[A-Za-z0-9_-]+_0$/);
    assert.deepEqual(h.state.finished, ['accepted']);
    assert.equal(h.state.hit, 1);
  } finally {
    if (prev === undefined) delete process.env.LINE_PUSH_PUBLIC_BASE_URL; else process.env.LINE_PUSH_PUBLIC_BASE_URL = prev;
    if (prevLiff === undefined) delete process.env.GAMES_LIFF_ID; else process.env.GAMES_LIFF_ID = prevLiff;
  }
});

test('webhook：同一事件重送不再回覆；同一人再次觸發沿用同一版', async () => {
  const prev = process.env.LINE_PUSH_PUBLIC_BASE_URL; process.env.LINE_PUSH_PUBLIC_BASE_URL = 'https://staging.example';
  try {
    const h = webhookHarness();
    await h.send([textEvent('EV-1')]);
    await h.send([textEvent('EV-1')]);                    // LINE 重送同一事件
    assert.equal(h.state.replies.length, 1, '重送不可重複回覆');
    assert.equal(h.state.deliveries.length, 1, '也不膨脹觸發次數');
    await h.send([textEvent('EV-2')]);                    // 同一人再觸發
    assert.equal(h.state.replies.length, 2);
    assert.deepEqual(h.state.deliveries.map(d => d.variant), ['b', 'b']);
    assert.equal(h.state.assignments.size, 1);
  } finally { if (prev === undefined) delete process.env.LINE_PUSH_PUBLIC_BASE_URL; else process.env.LINE_PUSH_PUBLIC_BASE_URL = prev; }
});

test('webhook：結果不確定→不算成功、不加命中；沒有用戶身分（群組）或查實驗失敗→照原本規則回覆', async () => {
  const prev = process.env.LINE_PUSH_PUBLIC_BASE_URL; process.env.LINE_PUSH_PUBLIC_BASE_URL = 'https://staging.example';
  try {
    const unsure = webhookHarness({ replyStatus: 'uncertain' });
    await unsure.send([textEvent('EV-9')]);
    assert.deepEqual(unsure.state.finished, ['uncertain']);
    assert.equal(unsure.state.hit, 0);
    const group = webhookHarness();
    await group.send([textEvent('EV-3', U('b'), 'group')]);
    assert.equal(group.state.replies[0].path, 'plain');
    assert.equal(group.state.replies[0].messages[0].text, 'STAGING 原本回覆');
    assert.equal(group.state.deliveries.length, 0);
    const broken = webhookHarness({ lookupFails: true });
    await broken.send([textEvent('EV-4')]);
    assert.equal(broken.state.replies[0].messages[0].text, 'STAGING 原本回覆', '實驗表不存在也要照常回覆');
    const none = webhookHarness({ experiment: null });
    await none.send([textEvent('EV-5')]);
    assert.equal(none.state.replies[0].messages[0].text, 'STAGING 原本回覆');
  } finally { if (prev === undefined) delete process.env.LINE_PUSH_PUBLIC_BASE_URL; else process.env.LINE_PUSH_PUBLIC_BASE_URL = prev; }
});

test('webhook：暫停後新觸發用固定版本、不進實驗、不追蹤', async () => {
  const prev = process.env.LINE_PUSH_PUBLIC_BASE_URL; process.env.LINE_PUSH_PUBLIC_BASE_URL = 'https://staging.example';
  try {
    const h = webhookHarness({ experiment: exp({ status: 'paused', fallback_variant: 'b' }) });
    await h.send([textEvent('EV-6')]);
    assert.equal(h.state.deliveries.length, 0);
    assert.equal(h.state.replies[0].messages[1].contents.hero.url, 'https://img.example/b.jpg');
    assert.equal(h.state.replies[0].messages[1].contents.footer.contents[0].action.uri, 'https://example.com/reward');
  } finally { if (prev === undefined) delete process.env.LINE_PUSH_PUBLIC_BASE_URL; else process.env.LINE_PUSH_PUBLIC_BASE_URL = prev; }
});

// ---------------------------------------------------------------- 後台 API
function adminRoutes(state) {
  const { registerAdminKeywordExperimentRoutes } = require('../src/routes/adminKeywordExperiments');
  const routes = {};
  const app = { get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; } };
  registerAdminKeywordExperimentRoutes(app, {
    query: async (sql, p = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('FROM admin_keyword_replies WHERE id')) return { rows: p[0] === 7 ? [{ id: 7, is_active: true }] : [] };
      if (s.includes('FROM admin_message_templates WHERE id')) return { rows: state.templates[p[0]] ? [state.templates[p[0]]] : [] };
      if (s.includes('INSERT INTO keyword_reply_experiments')) {
        if (state.open) { const e = new Error('dup'); e.code = '23505'; throw e; }
        state.inserted = p; return { rows: [{ id: 21 }] };
      }
      if (s.includes('FROM keyword_reply_experiments WHERE id')) return { rows: state.exp ? [{...state.exp,row_version:'1'}] : [] };
      if (s.includes('UPDATE keyword_reply_experiments SET')) { state.updates.push({ s, p }); return { rows: [Object.assign({}, state.exp, { status: s.includes("status = $2") ? p[1] : state.exp.status })] }; }
      return { rows: [] };
    },
    authCore: { requireAdmin: (_q, _s, n) => n() }, resolvePublicSiteOrigin: () => 'https://crm.example'
  });
  const call = async (key, req) => {
    const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const h = routes[key]; await h[h.length - 1](Object.assign({ authUser: { un: 'staging-admin' }, params: {}, body: {} }, req), out); return out;
  };
  return call;
}
const CREATE = 'POST /admin/keyword-replies/api/:ruleId(\\d+)/experiments';
const ACTION = 'POST /admin/keyword-replies/api/experiments/:id(\\d+)/:action(pause|resume|end|extend)';

test('建立測試：鎖定兩版快照與主要目標；驗證名稱、期間、素材；同規則只能一個未結束的測試', async () => {
  const state = { templates: { 1: { id: 1, name: 'STAGING A', message_config: CFG_A }, 2: { id: 2, name: 'STAGING B', message_config: CFG_B },
    3: { id: 3, name: 'Email', message_config: Object.assign({ channel: 'email' }, CFG_A) }, 4: { id: 4, name: '壞的', message_config: { mode: 'flex_json', flex: null } } }, updates: [] };
  const call = adminRoutes(state);
  const ok = await call(CREATE, { params: { ruleId: '7' }, body: { name: 'STAGING 封面', a_template_id: 1, b_template_id: 2, duration_days: 7, primary: { a: [0, 9], b: [0] } } });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.warnings, []);
  const p = state.inserted;
  assert.equal(JSON.parse(p[6]).items[1].message_config.flex.contents.hero.url, 'https://img.example/a.jpg', 'A 版內容快照');
  assert.deepEqual(JSON.parse(p[8]).primary, { a: [0], b: [0] }, '不存在的目標會被濾掉');
  const days = (new Date(p[10]) - new Date(p[9])) / 86400e3;
  assert.equal(Math.round(days), 7);
  const short = await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 2, duration_days: 3 } });
  assert.ok(short.body.warnings.some(w => /完整一週/.test(w)), '少於 7 天提醒但不禁止');
  const textB = { 5: { id: 5, name: '純文字', message_config: {mode:'sequence',items:[{type:'text',text:'STAGING 沒有連結'}]} } };
  Object.assign(state.templates, textB);
  const noTarget = await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 5 } });
  assert.equal(noTarget.body.ok, true, '沒有可追蹤連結也能做 A/B');
  assert.ok(noTarget.body.warnings.some(w => /不適用/.test(w)));
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { a_template_id: 1, b_template_id: 2 } })).body.error, 'name_required');
  assert.equal((await call(CREATE, { params: { ruleId: '99' }, body: { name: 'x', a_template_id: 1, b_template_id: 2 } })).statusCode, 404);
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 3 } })).statusCode, 400, 'Email 素材不能用');
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 4 } })).statusCode, 400, '組不成 LINE 訊息的素材不能用');
  const start = '2026-10-10T10:00:00+08:00';
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 2, start_at: start, end_at: '2026-10-10T09:00:00+08:00' } })).body.error, 'end_before_start');
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 2, duration_days: 120 } })).body.error, 'bad_duration');
  state.open = true;
  assert.equal((await call(CREATE, { params: { ruleId: '7' }, body: { name: 'x', a_template_id: 1, b_template_id: 2 } })).statusCode, 409);
});

test('測試操作：暫停／繼續／延長留紀錄；已結束不能再操作；延長必須晚於原結束時間', async () => {
  const state = { templates: {}, updates: [], exp: exp() };
  const call = adminRoutes(state);
  const pause = await call(ACTION, { params: { id: '11', action: 'pause' } });
  assert.equal(pause.body.ok, true);
  assert.match(state.updates[0].s, /change_log = change_log \|\|/);
  assert.equal(JSON.parse(state.updates[0].p[state.updates[0].p.length - 1])[0].action, 'pause');
  const notLater = await call(ACTION, { params: { id: '11', action: 'extend' }, body: { end_at: exp().start_at } });
  assert.equal(notLater.body.error, 'not_extended');
  const later = new Date(Date.now() + 20 * 86400e3).toISOString();
  const ext = await call(ACTION, { params: { id: '11', action: 'extend' }, body: { end_at: later } });
  assert.equal(ext.body.ok, true);
  const extLog = JSON.parse(state.updates[1].p[state.updates[1].p.length - 1])[0];
  assert.equal(extLog.action, 'extend');
  assert.equal(extLog.to, later);
  state.exp = exp({ status: 'ended' });
  assert.equal((await call(ACTION, { params: { id: '11', action: 'resume' } })).body.error, 'already_ended', '結束後不能重開');
  state.exp = exp({ end_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call(ACTION, { params: { id: '11', action: 'extend' }, body: { end_at: later } })).body.error, 'already_ended', '到期後也算結束');
});

// ---------------------------------------------------------------- 既有功能相容
test('規則清單：查不到 A/B 資料表時清單照常顯示、只是不提供 A/B', async () => {
  const { registerAdminKeywordRepliesRoutes } = require('../src/routes/adminKeywordReplies');
  const routes = {};
  const app = ['get', 'post', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  registerAdminKeywordRepliesRoutes(app, {
    query: async (sql) => {
      if (/keyword_reply_experiments/.test(sql)) throw new Error('relation does not exist');
      if (/FROM admin_keyword_replies r/.test(sql)) return { rows: [{ id: 7, keywords: 'STAGING', match_type: 'exact' }] };
      return { rows: [{ id: 1, name: 'STAGING A' }] };
    },
    authCore: { requireAdmin: (_q, _s, n) => n() }
  });
  const out = { status() { return this; }, json(b) { this.body = b; return this; } };
  const h = routes['GET /admin/keyword-replies/api/list'];
  await h[h.length - 1]({}, out);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.ab_enabled, false);
  assert.equal(out.body.rules.length, 1);
});

test('migration：只新增 4 張表、開 RLS、不寫死 schema；rollback 只刪這 4 張', () => {
  const up = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261002090000_keyword_reply_ab_tests.sql'), 'utf8');
  const down = fs.readFileSync(path.join(REPO, 'supabase/rollbacks/20261002090000_keyword_reply_ab_tests_rollback.sql'), 'utf8');
  const tables = ['keyword_reply_experiments', 'keyword_reply_experiment_assignments', 'keyword_reply_experiment_deliveries', 'keyword_reply_experiment_clicks'];
  tables.forEach(t => {
    assert.match(up, new RegExp('CREATE TABLE IF NOT EXISTS ' + t + ' '));
    assert.match(up, new RegExp('ALTER TABLE ' + t + ' ENABLE ROW LEVEL SECURITY'));
    assert.match(down, new RegExp('DROP TABLE IF EXISTS ' + t + ';'));
  });
  assert.doesNotMatch(up, /public\./, '不寫死 public，Staging 才會落在 crm_staging');
  assert.doesNotMatch(up, /ALTER TABLE admin_|DROP TABLE|^\s*UPDATE\s|^\s*DELETE\s+FROM/m, '不修改既有表或資料');
  assert.match(up, /keyword_reply_experiment_deliveries_event_uniq/);
  assert.match(up, /PRIMARY KEY \(experiment_id, line_user_id\)/);
});

// ---------------------------------------------------------------- 後台畫面
async function openKeywordPage(api) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_keyword_replies.ejs'), {
    title: '關鍵字回覆', user: 'admin', isAdmin: true, bodyClass: 'admin-shell'
  }, { views: [path.join(REPO, 'views')] });
  const posts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://crm.example/admin/keyword-replies', pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = () => {};
      window.confirm = () => true;
      window.fetch = async (url, opts) => {
        if (opts && opts.method === 'POST') posts.push({ url, body: JSON.parse(opts.body || '{}') });
        const r = api(url, opts);
        return { json: async () => r };
      };
    }
  });
  await wait(80);
  return { dom, doc: dom.window.document, window: dom.window, posts };
}
const LIST = (ab, enabled = true) => ({ ok: true, ab_enabled: enabled, rules: [
  { id: 7, keywords: '透過 OpenRice 訂位', match_type: 'exact', template_name: 'STAGING 原本', is_active: true, hit_count: 3, ab },
  { id: 8, keywords: '', match_type: 'fallback', template_name: 'STAGING 兜底', is_active: true, hit_count: 0, ab: null }],
  templates: [{ id: 1, name: 'STAGING A' }, { id: 2, name: 'STAGING B' }] });

test('畫面：規則列有 A/B 測試按鈕（兜底規則沒有）；建立流程先比對預覽再開始，送出期間與主要目標', async () => {
  const { dom, doc, window, posts } = await openKeywordPage((url) => {
    if (url === '/admin/keyword-replies/api/list') return LIST(null);
    if (url === '/admin/keyword-replies/api/7/experiments') return { ok: true, experiments: [], report: null };
    if (url === '/admin/keyword-replies/api/experiments/compare') return { ok: true,
      comparison: { differs: ['圖片'], onlyImages: true },
      summaries: { a: summarizeConfig(CFG_A, {}), b: summarizeConfig(CFG_B, {}) },
      targets: { a: [{ index: 0, label: '領獎勵', uri: 'https://example.com/reward' }], b: [{ index: 0, label: '領獎勵', uri: 'https://example.com/reward' }] } };
    if (url === '/admin/keyword-replies/api/7/experiments' ) return { ok: true };
    return { ok: true, experiment: { id: 21 }, warnings: [] };
  });
  const btns = doc.querySelectorAll('.kr-ab-btn');
  assert.equal(btns.length, 1, '兜底規則不提供 A/B');
  btns[0].click();
  await wait(30);
  assert.equal(doc.getElementById('kr-ab-card').hidden, false);
  assert.equal(doc.getElementById('kr-ab-start-btn').disabled, true, '比對前不能開始');
  doc.getElementById('kr-ab-name').value = 'STAGING 封面';
  doc.getElementById('kr-ab-a').value = '1';
  doc.getElementById('kr-ab-b').value = '2';
  doc.querySelector('[data-ab-days="14"]').click();
  doc.getElementById('kr-ab-compare').click();
  await wait(30);
  assert.match(doc.getElementById('kr-ab-compare-out').textContent, /只有圖片不同，適合測封面/);
  assert.equal(doc.querySelectorAll('[data-ab-target="a"]').length, 1);
  assert.equal(doc.getElementById('kr-ab-start-btn').disabled, false);
  doc.getElementById('kr-ab-start-btn').click();
  await wait(30);
  const create = posts.find(p => p.url === '/admin/keyword-replies/api/7/experiments');
  assert.deepEqual(create.body, { name: 'STAGING 封面', a_template_id: 1, b_template_id: 2, fallback_variant: 'a', primary: { a: [0], b: [0] }, duration_days: 14 });
  dom.window.close();
});

test('畫面：自訂期間少於 7 天出現提醒；時間以台灣時間送出', async () => {
  const { dom, doc, posts } = await openKeywordPage((url) => {
    if (url === '/admin/keyword-replies/api/list') return LIST(null);
    if (url === '/admin/keyword-replies/api/7/experiments') return { ok: true, experiments: [], report: null };
    if (url === '/admin/keyword-replies/api/experiments/compare') return { ok: true, comparison: { differs: ['圖片'], onlyImages: true },
      summaries: { a: summarizeConfig(CFG_A, {}), b: summarizeConfig(CFG_B, {}) }, targets: { a: [], b: [] } };
    return { ok: true, experiment: { id: 21 }, warnings: [] };
  });
  doc.querySelector('.kr-ab-btn').click();
  await wait(30);
  doc.querySelector('[data-ab-days="custom"]').click();
  doc.getElementById('kr-ab-start').value = '2026-10-10T10:00';
  doc.getElementById('kr-ab-end').value = '2026-10-13T10:00';
  doc.getElementById('kr-ab-end').dispatchEvent(new dom.window.Event('change'));
  assert.equal(doc.getElementById('kr-ab-week-warn').hidden, false);
  doc.getElementById('kr-ab-name').value = 'x';
  doc.getElementById('kr-ab-a').value = '1'; doc.getElementById('kr-ab-b').value = '2';
  doc.getElementById('kr-ab-compare').click();
  await wait(30);
  doc.getElementById('kr-ab-start-btn').click();
  await wait(30);
  const create = posts.find(p => p.url === '/admin/keyword-replies/api/7/experiments');
  assert.equal(create.body.start_at, '2026-10-10T10:00:00+08:00');
  assert.equal(create.body.end_at, '2026-10-13T10:00:00+08:00');
  dom.window.close();
});

test('畫面：進行中的測試顯示報表；不適用／尚無資料分開顯示，不顯示成 0%；可暫停、延長、結束', async () => {
  const report = { experiment_id: 11, state: 'running', attribution_days: 7, comparable: false, diff_pp_matured: null, variants: {
    a: { name: 'STAGING A', trackable: true, triggers: 3, assigned_users: 2, replies_ok: 2, reply_users: 2, replies_failed: 0, replies_uncertain: 1, target_clicks: 1, clickers: 1, ctr_observing: 50, matured_users: 0, matured_clickers: 0, ctr_matured: null },
    b: { name: 'STAGING B', trackable: false, triggers: 2, assigned_users: 2, replies_ok: 2, reply_users: 2, replies_failed: 0, replies_uncertain: 0, target_clicks: null, clickers: null, ctr_observing: null, matured_users: 0, matured_clickers: null, ctr_matured: null } } };
  const { dom, doc, posts } = await openKeywordPage((url) => {
    if (url === '/admin/keyword-replies/api/list') return LIST({ id: 11, name: 'STAGING', state: 'running' });
    if (url === '/admin/keyword-replies/api/7/experiments') return { ok: true, report,
      experiments: [{ id: 11, name: 'STAGING 封面', state: 'running', start_at: '2026-10-02T02:00:00Z', end_at: '2026-10-09T02:00:00Z', fallback_variant: 'a',
        change_log: [{ at: '2026-10-02T02:00:00Z', by: 'staging-admin', action: 'create' }] }] };
    return { ok: true, experiment: {}, state: 'paused' };
  });
  assert.match(doc.querySelector('.kr-ab-btn').textContent, /進行中/);
  doc.querySelector('.kr-ab-btn').click();
  await wait(30);
  const text = doc.getElementById('kr-ab-body').textContent;
  assert.match(text, /2026\/10\/2\s10:00:00/, '台灣時間顯示（UTC 02:00 → 台灣 10:00）');
  const rows = [...doc.querySelectorAll('.kr-ab-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
  const ctrMatured = rows.find(r => r[0] === '點擊率（已完成觀察）');
  assert.deepEqual(ctrMatured, ['點擊率（已完成觀察）', '尚無資料', '不適用']);
  assert.deepEqual(rows.find(r => r[0] === '目標點擊次數'), ['目標點擊次數', '1', '不適用']);
  assert.match(doc.querySelector('.kr-ab-diff').textContent, /目前無法比較：有一版沒有可追蹤的點擊目標/);
  assert.doesNotMatch(text, /自動判定.*勝出版/);
  doc.querySelector('[data-ab-act="pause"]').click();
  await wait(30);
  assert.ok(posts.some(p => p.url === '/admin/keyword-replies/api/experiments/11/pause'));
  doc.getElementById('kr-ab-extend-at').value = '2026-10-20T12:00';
  doc.querySelector('[data-ab-act="extend"]').click();
  await wait(30);
  assert.deepEqual(posts.find(p => /extend$/.test(p.url)).body, { end_at: '2026-10-20T12:00:00+08:00' });
  dom.window.close();
});

test('畫面：A/B 資料表還沒建立時，規則清單照常、不出現 A/B 按鈕', async () => {
  const { dom, doc } = await openKeywordPage((url) => (url === '/admin/keyword-replies/api/list' ? LIST(null, false) : { ok: true }));
  assert.equal(doc.querySelectorAll('#kr-tbody tr').length, 2);
  assert.equal(doc.querySelectorAll('.kr-ab-btn').length, 0);
  dom.window.close();
});

test('建立：非法開始時間回 400、不寫入；空值仍允許立即開始', async () => {
  const state = { templates: {1:{id:1,name:'A',message_config:CFG_A},2:{id:2,name:'B',message_config:CFG_B}}, updates: [] };
  const call = adminRoutes(state);
  const body = {name:'STAGING invalid',a_template_id:1,b_template_id:2,start_at:'not-a-date',duration_days:7};
  const bad = await call(CREATE,{params:{ruleId:'7'},body});
  assert.equal(bad.statusCode,400);assert.equal(bad.body.error,'bad_start');assert.equal(state.inserted,undefined);
  assert.equal((await call(CREATE,{params:{ruleId:'7'},body:{...body,start_at:''}})).body.ok,true);
});

test('到期可收尾 end；其他操作仍不能延長／重新開啟', async () => {
  const state = {templates:{},updates:[],exp:exp({status:'paused',end_at:new Date(Date.now()-1000).toISOString()})};
  const call=adminRoutes(state);
  assert.equal((await call(ACTION,{params:{id:'11',action:'resume'}})).body.error,'already_ended');
  assert.equal((await call(ACTION,{params:{id:'11',action:'end'}})).body.ok,true);
  assert.match(state.updates[0].s,/AND status = \$\d+ AND xmin::text = \$\d+/);
});

test('並行狀態變更 compare-and-set 沒有更新時回 409，不假裝成功', async () => {
  const {registerAdminKeywordExperimentRoutes}=require('../src/routes/adminKeywordExperiments');
  const routes={};let update;
  registerAdminKeywordExperimentRoutes({get(){},post(p,...h){routes[p]=h.at(-1);}},{authCore:{requireAdmin:(_q,_s,n)=>n()},query:async(s,p)=>{
    if(s.startsWith('SELECT *'))return {rows:[exp({status:'paused',row_version:'1'})]};
    update={s,p};return {rows:[]};
  }});
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};
  await Object.values(routes).find((_h,i)=>Object.keys(routes)[i].includes(':action'))({params:{id:'11',action:'resume'},body:{}},res);
  assert.equal(res.statusCode,409);assert.equal(res.body.error,'state_changed');
  assert.match(update.s,/AND end_at > statement_timestamp\(\)/);
});

function deferredResult() {let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
const previewResult=()=>({ok:true,comparison:{differs:['圖片'],onlyImages:true},summaries:{a:summarizeConfig(CFG_A,{}),b:summarizeConfig(CFG_B,{})},targets:{a:[],b:[]}});
async function uiUntil(fn) {const deadline=Date.now()+3000;while(!fn()){if(Date.now()>deadline)throw Error('UI condition timeout');await wait(10);}}

test('慢比對返回後不能覆蓋新素材；重新比對只送目前選擇', async () => {
  const old=deferredResult();let compares=0;
  const {dom,doc,posts}=await openKeywordPage((url,opts)=>{
    if(url.endsWith('/api/list'))return {...LIST(null),templates:[...LIST(null).templates,{id:3,name:'STAGING C'}]};
    if(url.endsWith('/experiments/compare'))return ++compares===1?old.promise:previewResult();
    if(opts&&opts.method==='POST')return {ok:false,error:'synthetic-no-write'};
    return {ok:true,experiments:[],report:null};
  });
  try {
    doc.querySelector('.kr-ab-btn').click();await uiUntil(()=>doc.getElementById('kr-ab-a'));
    doc.getElementById('kr-ab-name').value='STAGING race';
    doc.getElementById('kr-ab-a').value='1';doc.getElementById('kr-ab-b').value='2';doc.getElementById('kr-ab-compare').click();
    doc.getElementById('kr-ab-b').value='3';doc.getElementById('kr-ab-b').dispatchEvent(new dom.window.Event('change'));
    old.resolve(previewResult());await wait(30);
    assert.equal(doc.getElementById('kr-ab-start-btn').disabled,true);assert.equal(doc.getElementById('kr-ab-compare-out').textContent,'');
    doc.getElementById('kr-ab-compare').click();await uiUntil(()=>!doc.getElementById('kr-ab-start-btn').disabled);
    doc.getElementById('kr-ab-start-btn').click();await uiUntil(()=>posts.some(p=>/api\/7\/experiments$/.test(p.url)));
    assert.equal(posts.find(p=>/api\/7\/experiments$/.test(p.url)).body.b_template_id,3);
    await uiUntil(()=>/synthetic-no-write/.test(doc.getElementById('kr-ab-create-status').textContent));
  } finally {dom.window.close();}
});

test('慢比對遇到关闭／切換規則不污染新面板；預覽斷線仍禁止開始', async () => {
  const old=deferredResult();let compares=0;
  const {dom,doc}=await openKeywordPage(url=>{
    if(url.endsWith('/api/list'))return LIST(null);
    if(url.endsWith('/experiments/compare'))return ++compares===1?old.promise:Promise.reject(Error('offline'));
    return {ok:true,experiments:[],report:null};
  });
  try {
    doc.querySelector('.kr-ab-btn').click();await uiUntil(()=>doc.getElementById('kr-ab-a'));
    doc.getElementById('kr-ab-a').value='1';doc.getElementById('kr-ab-b').value='2';doc.getElementById('kr-ab-compare').click();
    doc.getElementById('kr-ab-close').click();doc.querySelector('.kr-ab-btn').click();await uiUntil(()=>doc.getElementById('kr-ab-a'));
    old.resolve(previewResult());await wait(30);
    assert.equal(doc.getElementById('kr-ab-start-btn').disabled,true);assert.equal(doc.getElementById('kr-ab-compare-out').textContent,'');
    doc.getElementById('kr-ab-a').value='1';doc.getElementById('kr-ab-b').value='2';doc.getElementById('kr-ab-compare').click();
    await uiUntil(()=>/預覽載入失敗/.test(doc.getElementById('kr-ab-compare-out').textContent));
    assert.equal(doc.getElementById('kr-ab-start-btn').disabled,true);
  } finally {dom.window.close();}
});

test('開始前再次核對素材，即使未觸發 change 也不會送舊版本', async () => {
  const {dom,doc,posts}=await openKeywordPage(url=>url.endsWith('/api/list')?{...LIST(null),templates:[...LIST(null).templates,{id:3,name:'C'}]}:url.endsWith('/experiments/compare')?previewResult():{ok:true,experiments:[],report:null});
  try {
    doc.querySelector('.kr-ab-btn').click();await uiUntil(()=>doc.getElementById('kr-ab-a'));
    doc.getElementById('kr-ab-name').value='STAGING';doc.getElementById('kr-ab-a').value='1';doc.getElementById('kr-ab-b').value='2';doc.getElementById('kr-ab-compare').click();
    await uiUntil(()=>!doc.getElementById('kr-ab-start-btn').disabled);
    doc.getElementById('kr-ab-b').value='3';doc.getElementById('kr-ab-start-btn').click();
    assert.equal(posts.filter(p=>/api\/7\/experiments$/.test(p.url)).length,0);
    assert.match(doc.getElementById('kr-ab-create-status').textContent,/素材已變更/);
  } finally {dom.window.close();}
});
