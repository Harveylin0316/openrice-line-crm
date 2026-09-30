'use strict';
// 這一批：指標定義、領券成效、測試帳號重玩、複製序號事件、近期群發成效顯示 LINE 通知文字。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const DEFS_JS = fs.readFileSync(path.join(REPO, 'public/activity-metric-defs.js'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));
const U = c => 'U' + c.repeat(32);

async function openPlayers(gameType, api) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_players.ejs'), {
    title: '玩家', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activity: { id: 9, name: '測試活動', game_type: gameType, base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3 }
  }, { views: [path.join(REPO, 'views')] });
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://crm.example/admin/activities/9/players',
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      window.fetch = async (u, opts) => {
        calls.push({ u, opts });
        if (/\/testers\/reset$/.test(u)) return { json: async () => ({ ok: true, results: [] }) };
        if (/\/testers$/.test(u)) return { json: async () => api.testers };
        return { json: async () => api.players };
      };
    }
  });
  // 外部 <script src> 在 jsdom 不會載入：手動掛上定義檔再觸發一次初始化
  dom.window.eval(DEFS_JS);
  await wait(120);
  dom.window.ActivityMetricDefs.init(dom.window.document);
  return { dom, doc: dom.window.document, calls };
}

const TESTERS = { ok: true, testers: [
  { label: '分享者', line_user_id: U('a'), plays: 3, new_friend_invites: 1, bonus_plays: 2 },
  { label: '被邀請者', line_user_id: U('b'), plays: 1, new_friend_invites: 0, bonus_plays: 0 }
] };
const CLAIM_FUNNEL = {
  cutoff: '2026-09-01', window_days: 7,
  all: { opened: 10, shown: 8, out_of_stock: 1, copied: 5, redeemed: 3, matured: 7, shown_rate: 80, copied_rate: 50, redeemed_rate: 30 },
  existing: { opened: 6, shown: 5, out_of_stock: 0, copied: 3, redeemed: 2, matured: 6, shown_rate: 83.3, copied_rate: 50, redeemed_rate: 33.3 },
  new: { opened: 4, shown: 3, out_of_stock: 1, copied: 2, redeemed: 1, matured: 1, shown_rate: 75, copied_rate: 50, redeemed_rate: 25 },
  unknown: { opened: 0, shown: 0, out_of_stock: 0, copied: 0, redeemed: 0, matured: 0 }
};

test('每一個標了 data-metric 的指標都有定義（輪盤頁、領券頁、活動列表），並產生定義表', async () => {
  const defsWindow = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window;
  defsWindow.eval(DEFS_JS);
  const DEFS = defsWindow.ActivityMetricDefs.DEFS;
  const checkPage = (doc, where, min) => {
    const keys = [...doc.querySelectorAll('[data-metric]')].map(el => el.getAttribute('data-metric'));
    assert.ok(keys.length >= (min || 6), where + ' 應有指標');
    keys.forEach(k => assert.ok(DEFS[k], where + ' 的 ' + k + ' 沒有定義'));
    // 每個標記旁邊都真的出現「?」
    [...doc.querySelectorAll('[data-metric]')].forEach(el => assert.ok(el.querySelector('.mdef-i'), where + ' ' + el.getAttribute('data-metric') + ' 沒有 ? 按鈕'));
    return keys;
  };
  const wheel = await openPlayers('wheel', {
    testers: TESTERS,
    players: { ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: [{ plays: 1, users: 2 }], claim_funnel: null }
  });
  const wheelKeys = checkPage(wheel.doc, '輪盤玩家數據');
  ['ov_wins', 'fn_open', 'pl_left', 'dist_share', 'ts_invites'].forEach(k => assert.ok(wheelKeys.includes(k), k));
  const glossary = wheel.doc.querySelector('[data-metric-glossary]');
  assert.match(glossary.textContent, /指標定義/);
  assert.match(glossary.textContent, /銘謝惠顧不算/);
  wheel.dom.window.close();

  const claim = await openPlayers('claim', {
    testers: TESTERS,
    players: { ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: [], claim_funnel: CLAIM_FUNNEL }
  });
  const claimKeys = checkPage(claim.doc, '領券玩家數據');
  ['cl_open', 'cl_shown', 'cl_copy', 'cl_redeem', 'cl_oos', 'cl_existing', 'cl_new', 'cl_window', 'cl_immature'].forEach(k => assert.ok(claimKeys.includes(k), k));
  claim.dom.window.close();

  const listHtml = await ejs.renderFile(path.join(REPO, 'views/admin_activities.ejs'), {
    title: '活動', user: 'admin', isAdmin: true, bodyClass: 'admin-shell'
  }, { views: [path.join(REPO, 'views')] });
  const listDom = new JSDOM(listHtml, { runScripts: 'outside-only' });
  listDom.window.eval(DEFS_JS);
  listDom.window.ActivityMetricDefs.init(listDom.window.document);
  assert.deepEqual(checkPage(listDom.window.document, '活動列表', 3), ['list_prizes', 'list_players', 'list_plays']);
});

test('領券活動：顯示領券成效（全部／既有好友／新好友、對開啟 %、觀察期未滿），隱藏抽獎用的漏斗與分布', async () => {
  const { dom, doc, calls } = await openPlayers('claim', {
    testers: TESTERS,
    players: { ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: [], claim_funnel: CLAIM_FUNNEL }
  });
  assert.equal(doc.getElementById('claim-funnel-card').hidden, false);
  assert.equal(doc.getElementById('funnel-card').hidden, true);
  assert.equal(doc.getElementById('play-dist-card').hidden, true);
  const heads = [...doc.querySelectorAll('#claim-table thead th')].map(th => th.textContent.replace('?', ''));
  assert.deepEqual(heads, ['步驟', '全部', '既有好友', '新好友']);   // 未知 0 人不顯示
  const rows = [...doc.querySelectorAll('#claim-table tbody tr')].map(tr => tr.querySelector('td').textContent.replace('?', ''));
  assert.deepEqual(rows, ['開啟畫面', '顯示序號', '複製序號', '前往兌換', '序號發完']);
  const redeemAll = doc.querySelectorAll('#claim-table tbody tr')[3].querySelectorAll('td')[1].textContent;
  assert.match(redeemAll, /^3\s*30%/);
  assert.match(doc.getElementById('claim-foot').textContent, /2026-09-01 前加入/);
  assert.match(doc.getElementById('claim-foot').textContent, /3 人.*觀察期未滿/);
  // 觀察期、分界日一起帶進查詢
  const playersCall = calls.find(c => /\/players/.test(c.u));
  assert.match(playersCall.u, /window=7/);
  assert.match(playersCall.u, /cutoff=2026-09-01/);
  doc.getElementById('cf-window').value = '14';
  doc.getElementById('cf-window').dispatchEvent(new dom.window.Event('change'));
  await wait(30);
  assert.match(calls.filter(c => /\/players/.test(c.u)).pop().u, /window=14/);
  dom.window.close();
});

test('非領券活動不顯示領券成效，也不帶觀察期參數', async () => {
  const { dom, doc, calls } = await openPlayers('wheel', {
    testers: { ok: true, testers: [] },
    players: { ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: [], claim_funnel: null }
  });
  assert.equal(doc.getElementById('claim-funnel-card').hidden, true);
  assert.equal(doc.getElementById('funnel-card').hidden, false);
  assert.doesNotMatch(calls.find(c => /\/players/.test(c.u)).u, /window=/);
  assert.match(doc.getElementById('tester-list').textContent, /還沒有測試帳號/);
  // 提示是一整段文字，不能被格狀排列拆成好幾格
  assert.equal(doc.getElementById('tester-list').children.length, 1);
  assert.equal(doc.getElementById('tester-list').firstElementChild.className, 'tester-empty');
  dom.window.close();
});

test('測試帳號重玩：列出每個測試帳號的進度，可單一重置或全部重置', async () => {
  const { dom, doc, calls } = await openPlayers('wheel', {
    testers: TESTERS,
    players: { ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: [], claim_funnel: null }
  });
  const rows = doc.querySelectorAll('.tester-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /分享者/);
  assert.match(rows[0].textContent, /3次抽獎/);
  assert.match(rows[0].textContent, /1位成功邀請/);
  rows[0].querySelector('[data-reset]').click();
  await wait(30);
  const one = calls.find(c => /\/testers\/reset$/.test(c.u));
  assert.deepEqual(JSON.parse(one.opts.body), { line_user_id: U('a') });
  assert.equal(doc.getElementById('tester-reset-all').hidden, false);
  doc.getElementById('tester-reset-all').click();
  await wait(30);
  const all = calls.filter(c => /\/testers\/reset$/.test(c.u)).pop();
  assert.deepEqual(JSON.parse(all.opts.body), { all: true });
  dom.window.close();
});

test('重置只接受測試人員名單上的帳號；交易失敗會回滾', async () => {
  const { resetTesterInActivity } = require('../src/core/activityTesters');
  const sqls = [];
  const client = { query: async (sql) => { sqls.push(String(sql).trim().split(/\s+/).slice(0, 3).join(' ')); return { rows: [], rowCount: 0 }; }, release() {} };
  await assert.rejects(resetTesterInActivity({ connect: async () => client }, 9, U('c')), (e) => e.code === 'not_tester');
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.some(s => s.startsWith('DELETE')), '不在名單上就不能刪任何東西');
  await assert.rejects(resetTesterInActivity({ connect: async () => client }, 9, 'bad'), (e) => e.code === 'bad_uid');
});

test('邀請判定：兩個測試帳號互邀一律算新好友；有一方不是測試帳號就照一般規則', async () => {
  const { registerReferral } = require('../src/core/gamePlayEngine');
  const oa = require('../src/core/oaFollower');
  const orig = oa.verifyOaFollower;
  const inserted = [];
  const make = (testerIds) => async (sql, params) => {
    const c = String(sql).replace(/\s+/g, ' ');
    if (/FROM activities WHERE slug/.test(c)) return { rows: [{ id: 9, status: 'active', referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1 }] };
    if (/SELECT 1 FROM users WHERE line_user_id = \$1 AND archived_at IS NULL/.test(c)) return { rows: [{ 1: 1 }] };
    if (/AS was_existing/.test(c)) return { rows: [{ was_existing: true }] };   // 一般規則：原本就是好友
    if (/FROM admin_test_recipients/.test(c)) return { rows: [{ n: params[0].filter(u => testerIds.includes(u)).length }] };
    if (/INSERT INTO activity_referrals/.test(c)) { inserted.push(params[3]); return { rows: [{ id: 1 }] }; }
    return { rows: [] };
  };
  try {
    // 直接替換模組上的函式不一定生效（已解構引用），所以用 followConfirmed 跳過 LINE API
    const pair = await registerReferral({ query: make([U('a'), U('b')]), activitySlug: 's', gameType: 'mgm', inviterId: U('a'), inviteeId: U('b'), followConfirmed: true });
    assert.equal(pair.ok, true);
    assert.equal(pair.invitee_was_existing, false);
    const mixed = await registerReferral({ query: make([U('a')]), activitySlug: 's', gameType: 'mgm', inviterId: U('a'), inviteeId: U('d'), followConfirmed: true });
    assert.equal(mixed.invitee_was_existing, true);
    assert.deepEqual(inserted, [false, true]);
  } finally { oa.verifyOaFollower = orig; }
});

test('領券頁按「複製序號」會記 copy_code 事件；只有領券活動接受這個事件', async () => {
  const src = fs.readFileSync(path.join(REPO, 'views/game_claim.ejs'), 'utf8');
  assert.match(src, /event_name: 'copy_code'/);
  assert.match(src, /function copyCode\(\)\{[\s\S]{0,200}trackCopy\(\);/);
  const games = fs.readFileSync(path.join(REPO, 'src/routes/games.js'), 'utf8');
  assert.match(games, /'redeem_click'/);

  const { registerGameType } = require('../src/routes/gamesGeneric');
  const prev = process.env.LIFF_TOKEN_ENFORCE;
  process.env.LIFF_TOKEN_ENFORCE = '0';
  try {
    for (const [gameType, expectOk] of [['claim', true], ['wheel', false]]) {
      const routes = {};
      const inserts = [];
      const app = { get() {}, post(p, ...h) { routes[p] = h; } };
      registerGameType(app, {
        query: async (sql, params) => {
          if (/INSERT INTO activity_user_events/.test(sql)) { inserts.push(params[2]); return { rows: [] }; }
          return { rows: [{ id: 9, liff_id_override: null }] };
        }, pool: {}
      }, { gameType, viewName: 'game_' + gameType, defaultLiffId: 'L' });
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/api/games/' + gameType + '/:slug/event'][0]({ params: { slug: 's' }, body: { line_user_id: U('a'), event_name: 'copy_code' } }, res);
      if (expectOk) { assert.equal(res.body.ok, true, JSON.stringify(res.body)); assert.deepEqual(inserts, ['copy_code']); }
      else { assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_event'); }
    }
  } finally {
    if (prev === undefined) delete process.env.LIFF_TOKEN_ENFORCE; else process.env.LIFF_TOKEN_ENFORCE = prev;
  }
});

test('近期群發成效：每列帶 LINE 通知預覽文字（卡片 altText、多段訊息第一段），與標題相同就不重複', async () => {
  const { getBroadcastMessageIdentity } = require('../src/core/broadcastMessageSnapshot');
  const card = getBroadcastMessageIdentity({ channel: 'line', message_config: { mode: 'flex_json', flex: { type: 'flex', altText: '中秋抽機票，今天最後一天', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '中秋活動' }] } } } }, audience_config: { messageSource: { id: 3, name: '中秋抽機票_Click' } } });
  assert.equal(card.title, '中秋抽機票_Click');
  assert.equal(card.notificationText, '中秋抽機票，今天最後一天');
  const seq = getBroadcastMessageIdentity({ channel: 'line', message_config: { mode: 'sequence', items: [{ type: 'text', text: '哈囉，分享超有哩開跑了' }, { type: 'card', message_config: { mode: 'template', template: { title: 't', altText: 'x' } } }] } });
  assert.equal(seq.notificationText, '哈囉，分享超有哩開跑了');
  const img = getBroadcastMessageIdentity({ channel: 'line', message_config: { mode: 'sequence', items: [{ type: 'image', originalContentUrl: 'https://x/a.jpg' }] } });
  assert.equal(img.notificationText, '傳送了圖片');

  const view = fs.readFileSync(path.join(REPO, 'views/admin_attribution.ejs'), 'utf8');
  const start = view.indexOf('tbody.innerHTML = rows.map(function (b) {');
  assert.ok(start > 0);
  const route = fs.readFileSync(path.join(REPO, 'src/routes/adminAttribution.js'), 'utf8');
  assert.match(route, /notification_text: identity\.notificationText/);
  assert.match(view, /b\.notification_text && b\.notification_text !== b\.label/);
});
