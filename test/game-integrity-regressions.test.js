'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { verifyGameOaFollower } = require('../src/core/oaFollower');
const { selectPrizeAndRecord, registerReferral } = require('../src/core/gamePlayEngine');
const { loadActivityFunnel } = require('../src/core/activityFunnel');
const { registerGameType } = require('../src/routes/gamesGeneric');
const UID = 'U' + 'b'.repeat(32);
const INVITER = 'U' + 'a'.repeat(32);
const ROOT = path.join(__dirname, '..');

test('好友證明必須綁定相同 channel、相同用戶、未過期 token 與 LINE friendFlag', async () => {
  const oldFetch = global.fetch;
  const cases = [
    { friendFlag: true, want: true }, { friendFlag: false, want: false },
    { friendFlag: true, userId: INVITER, want: null },
    { friendFlag: true, client_id: 'other-channel', want: null },
    { friendFlag: true, expires_in: 0, want: null },
    { friendFlag: 'true', want: null }, { status: 503, want: null },
    { throws: true, want: null }
  ];
  try {
    for (const c of cases) {
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push(url);
        assert.ok(opts.signal, 'LINE 請求必須設逾時');
        if (c.throws) throw new Error('unavailable');
        return { status: c.status || 200, json: async () =>
          String(url).includes('/oauth2/') ? { client_id: c.client_id || '2000', expires_in: c.expires_in ?? 300 } :
          String(url).includes('/friendship/') ? { friendFlag: c.friendFlag } : { userId: c.userId || UID } };
      };
      assert.equal(await verifyGameOaFollower(UID, { accessToken: 'access', channelId: '2000' }), c.want);
      assert.equal(calls.length, 3);
      assert.ok(calls.every(u => !u.includes('/v2/bot/profile/')), 'bot profile 200 不是好友證明');
    }
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not call'); };
    assert.equal(await verifyGameOaFollower(UID, { channelId: '2000' }), null);
    assert.equal(calls, 0);
  } finally { global.fetch = oldFetch; }
});

test('遊玩路由：非好友、API 無法判定與錯配 access token 都不寫遊玩或開始事件', async () => {
  const oldFetch = global.fetch, oldEnforce = process.env.LIFF_TOKEN_ENFORCE;
  process.env.LIFF_TOKEN_ENFORCE = '1';
  try {
    for (const c of [{ flag: false, error: 'must_follow_oa' }, { status: 503, error: 'follow_check_unavailable' }, { flag: true, uid: INVITER, error: 'follow_check_unavailable' }]) {
      let connected = 0, starts = 0;
      const routes = {};
      const query = async sql => {
        if (/INSERT INTO activity_user_events/.test(sql)) starts++;
        if (/SELECT require_follow_oa/.test(sql)) return { rows: [{ require_follow_oa: true, liff_id_override: null }] };
        return { rows: [] };
      };
      global.fetch = async (url, opts) => ({ status: c.status || 200, text: async () => '{}', json: async () =>
        opts.method === 'POST' ? { sub: UID, aud: '2000' } :
        String(url).includes('/oauth2/') ? { client_id: '2000', expires_in: 300 } :
        String(url).includes('/friendship/') ? { friendFlag: c.flag } : { userId: c.uid || UID } });
      // ID token 驗證成功，僅讓好友 API 碰到 503。
      const fetched = global.fetch;
      global.fetch = (url, opts) => opts.method === 'POST'
        ? Promise.resolve({ status: 200, json: async () => ({ sub: UID, aud: '2000' }), text: async () => '{}' })
        : fetched(url, opts);
      registerGameType({ get() {}, post(p, fn) { routes[p] = fn; } }, { query, pool: { connect: async () => { connected++; throw new Error('must not play'); } } },
        { gameType: 'wheel', viewName: 'game_wheel', defaultLiffId: '2000-test' });
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } };
      await routes['/api/games/wheel/:slug/spin']({ params: { slug: 's' }, body: { line_user_id: UID, id_token: 'id', access_token: 'access', play_key: 'valid-key' } }, res);
      assert.equal(res.body.error, c.error);
      assert.equal(connected, 0);
      assert.equal(starts, 0);
    }
  } finally {
    global.fetch = oldFetch;
    if (oldEnforce == null) delete process.env.LIFF_TOKEN_ENFORCE; else process.env.LIFF_TOKEN_ENFORCE = oldEnforce;
  }
});

function serializedPool({ total = 2, daily = 1 } = {}) {
  const plays = [], sqls = [];
  let tail = Promise.resolve();
  const pool = { connect: async () => {
    let unlock;
    return { release() {}, query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ');
      sqls.push(q);
      if (/pg_advisory_xact_lock/.test(q)) {
        assert.deepEqual(params, ['game-play:6:' + UID]);
        const previous = tail;
        tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        return { rows: [] };
      }
      if (/^(COMMIT|ROLLBACK)/.test(q)) { if (unlock) { unlock(); unlock = null; } return { rows: [] }; }
      if (/FROM activities WHERE slug/.test(q)) return { rows: [{ id: 6, status: 'active',
        base_plays_per_user: total, referral_bonus_per: 0, referral_bonus_max: 0, daily_plays_per_user: daily }] };
      if (/properties->>'play_key' = \$3/.test(q)) return { rows: plays.filter(p => p.key === params[2]) };
      if (/COUNT\(\*\) AS c FROM activity_plays/.test(q)) return { rows: [{ c: plays.length }] };
      if (/FROM activity_referrals/.test(q)) return { rows: [{ c: 0, existing: 0 }] };
      if (/FROM activity_bonus_plays/.test(q)) return { rows: [{ b: 0 }] };
      if (/FROM activity_user_quotas/.test(q)) return { rows: [] };
      if (/FROM activity_prizes/.test(q)) return { rows: [{ id: 11, name: '銘謝惠顧',
        probability_weight: 1, stock_total: null, stock_remaining: null, prize_type: 'none', prize_value: {} }] };
      if (/INSERT INTO activity_plays/.test(q)) {
        const row = { id: plays.length + 1, prize_id: 11, prize_snapshot: JSON.parse(params[4]),
          key: JSON.parse(params[5]).play_key, played_at: new Date().toISOString() };
        plays.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    } };
  } };
  return { pool, plays, sqls };
}

test('同人併發：每日上限不能在兩個請求之間穿透，台灣午夜而非 UTC 重置', async () => {
  const db = serializedPool();
  const run = key => selectPrizeAndRecord({ pool: db.pool, activitySlug: 's', gameType: 'wheel', lineUserId: UID, playKey: key });
  const results = await Promise.all([run('parallel-1'), run('parallel-2')]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => r.error).error.code, 'daily_limit_reached');
  assert.equal(db.plays.length, 1);
  const dailySql = db.sqls.find(q => /played_at >=/.test(q));
  assert.match(dailySql, /statement_timestamp\(\) AT TIME ZONE 'Asia\/Taipei'/);
  assert.ok(db.sqls.findIndex(q => /pg_advisory/.test(q)) < db.sqls.findIndex(q => /COUNT\(\*\) AS c FROM activity_plays/.test(q)));
});

test('同鑰匙併發重送只寫一筆、回同結果；不同鑰匙仍不能超過總額', async () => {
  for (const sameKey of [true, false]) {
    const db = serializedPool({ total: 1, daily: null });
    const run = key => selectPrizeAndRecord({ pool: db.pool, activitySlug: 's', gameType: 'wheel', lineUserId: UID, playKey: key });
    const results = await Promise.all([run('retry-key-1'), run(sameKey ? 'retry-key-1' : 'retry-key-2')]);
    assert.equal(db.plays.length, 1);
    if (sameKey) { assert.ok(results.every(r => r.ok)); assert.equal(results[0].play_id, results[1].play_id); assert.equal(results[1].replayed, true); }
    else assert.equal(results.find(r => r.error).error.code, 'quota_exhausted');
  }
});

test('referral 重送回原始入帳的新舊好友狀態，不能因後來成會員而翻轉', async () => {
  const query = async sql => {
    if (/FROM activities WHERE slug/.test(sql)) return { rows: [{ id: 6, status: 'active', referral_bonus_per: 1 }] };
    if (/SELECT 1 FROM users/.test(sql)) return { rows: [{}] };
    if (/AS was_existing/.test(sql)) return { rows: [{ was_existing: true }] };
    if (/SELECT inviter_line_user_id, invitee_was_existing/.test(sql)) return { rows: [{ inviter_line_user_id: INVITER, invitee_was_existing: false }] };
    return { rows: [] };
  };
  const result = await registerReferral({ query, activitySlug: 's', gameType: 'wheel', inviterId: INVITER, inviteeId: UID, followConfirmed: true });
  assert.equal(result.counted, false);
  assert.equal(result.same_inviter, true);
  assert.equal(result.invitee_was_existing, false);
});

test('歷史範圍的 24 小時／7 天開啟統計不被舊期間截斷', async () => {
  const sqls = [];
  await loadActivityFunnel(async sql => { sqls.push(sql); return { rows: [] }; }, 6, { from: '2026-08-01', to: '2026-08-02' });
  assert.match(sqls[0], /FROM activity_user_events recent[\s\S]*recent\.created_at >= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(sqls[0], /FROM activity_user_events recent[\s\S]*recent\.created_at >= NOW\(\) - INTERVAL '7 days'/);
  assert.doesNotMatch(sqls[0], /e\.created_at >= NOW\(\)/);
});

test('所有遊戲及 MGM 分享頁都傳 Login access token，並換新版共用腳本', () => {
  ['wheel','scratch','slot','fortune','claim'].forEach(type => {
    const html = fs.readFileSync(path.join(ROOT, 'views/game_' + type + '.ejs'), 'utf8');
    assert.match(html, /access_token:\s*liff\.getAccessToken\(\)/);
    assert.match(html, /games-mgm\.js\?v=20261001b/);
  });
  assert.match(fs.readFileSync(path.join(ROOT, 'public/games-mgm.js'), 'utf8'), /access_token:[\s\S]*getAccessToken/);
  assert.match(fs.readFileSync(path.join(ROOT, 'views/mgm_share.ejs'), 'utf8'), /games-mgm\.js\?v=20261001b/);
});

const wait = () => new Promise(resolve => setTimeout(resolve, 30));
function api(n, funnel = true) {
  return { ok: true, players: [], overview: { total_plays: n, unique_players: n, total_wins: 0, tester_players: 2, tester_plays: 20 },
    funnel: funnel ? { openers: n, starters: n, completers: n, sharers: 0, openers_7d: n, openers_24h: n, trend: [] } : null,
    play_distribution: [] };
}
test('日期快切只顯示最新請求；讀取失敗不留舊漏斗／舊玩家，並標示測試資料', async () => {
  const html = await ejs.renderFile(path.join(ROOT, 'views/admin_activity_players.ejs'), {
    title: '玩家', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activity: { id: 6, name: '分享', game_type: 'wheel', base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3 }
  });
  const pending = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://crm.example/admin/activities/6/players', beforeParse(w) {
    w.fetch = url => /\/players(?:\?|$)/.test(url)
      ? new Promise(resolve => pending.push(data => resolve({ json: async () => data })))
      : Promise.resolve({ json: async () => ({ ok: true, testers: [] }) });
  } });
  const doc = dom.window.document;
  try {
    assert.equal(pending.length, 1);
    doc.querySelector('[data-range="today"]').click();
    pending[1](api(502)); await wait();
    assert.equal(doc.getElementById('ov-plays').textContent, '502');
    assert.match(doc.getElementById('tester-metric-note').textContent, /一般玩家 500 人／482 次.*測試帳號 2 人／20 次/);
    pending[0](api(999)); await wait();
    assert.equal(doc.getElementById('ov-plays').textContent, '502', '舊請求不能蓋掉新的日期');
    doc.querySelector('[data-range="yesterday"]').click();
    assert.equal(doc.getElementById('fn-openers').textContent, '—', '載入時先清除舊數字');
    pending[2]({ ok: false, detail: 'temporary error' }); await wait();
    assert.equal(doc.getElementById('ov-plays').textContent, '—');
    assert.equal(doc.getElementById('fn-openers').textContent, '—');
    assert.equal(doc.getElementById('tester-metric-note').hidden, true);
    doc.querySelector('[data-range="all"]').click();
    pending[3](api(40, false)); await wait();
    assert.equal(doc.getElementById('ov-plays').textContent, '40');
    assert.equal(doc.getElementById('fn-openers').textContent, '—');
    assert.match(doc.getElementById('funnel-meta').textContent, /暫時讀不到/);
  } finally { dom.window.close(); }
});
