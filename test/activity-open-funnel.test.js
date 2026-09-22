// 活動開啟成效漏斗：以不重複用戶計算、日期以台北曆日、任何 DB 失敗都不能拖垮玩家清單。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { loadActivityFunnel, TREND_DAYS } = require('../src/core/activityFunnel');

const REPO = path.join(__dirname, '..');

test('漏斗以不重複用戶計算並回傳轉換率', async () => {
  const calls = [];
  const query = async (sql, params) => {
    const c = String(sql).replace(/\s+/g, ' ');
    calls.push({ sql: c, params });
    if (/AS openers,/.test(c) && /first_open_at/.test(c)) {
      return { rows: [{ openers: '200', starters: '120', completers: '100', sharers: '25', shares: '31', openers_24h: '9', openers_7d: '80', first_open_at: '2026-09-01T00:00:00Z', last_open_at: '2026-09-21T10:00:00Z' }] };
    }
    return { rows: [{ day: new Date('2026-09-20T00:00:00Z'), openers: '5', completers: '3', sharers: '1' }, { day: '2026-09-21', openers: '7', completers: '4', sharers: '2' }] };
  };
  const f = await loadActivityFunnel(query, 9);
  assert.equal(f.openers, 200);
  assert.equal(f.start_rate, 60);
  assert.equal(f.complete_rate, 50);
  assert.equal(f.share_rate, 12.5);
  assert.equal(f.shares, 31);
  assert.deepEqual(f.trend.map(t => t.day), ['2026-09-20', '2026-09-21']);
  assert.equal(f.trend[1].openers, 7);
  assert.match(calls[0].sql, /COUNT\(DISTINCT line_user_id\) FILTER \(WHERE event_name = 'enter'\)/);
  assert.match(calls[1].sql, /AT TIME ZONE 'Asia\/Taipei'/);
  assert.deepEqual(calls[1].params, [9, TREND_DAYS]);
});

test('沒有任何事件時轉換率為 null 而不是 0 或 NaN', async () => {
  const query = async (sql) => (/first_open_at/.test(sql) ? { rows: [{}] } : { rows: [] });
  const f = await loadActivityFunnel(query, 9);
  assert.equal(f.openers, 0);
  assert.equal(f.start_rate, null);
  assert.deepEqual(f.trend, []);
});

test('玩家數據頁渲染漏斗區塊，且成效讀不到時清單照常顯示', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_players.ejs'), {
    title: '玩家', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activity: { id: 9, name: '夏日刮刮樂', game_type: 'scratch', base_plays_per_user: 0, referral_bonus_per: 1, referral_bonus_max: 3 }
  }, { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin/activities/9/players',
    beforeParse(window) {
      window.fetch = async () => ({ json: async () => ({
        ok: true, players: [], overview: { total_plays: 4 },
        funnel: { openers: 40, starters: 30, completers: 28, sharers: 4, shares: 5, openers_24h: 2, openers_7d: 10, start_rate: 75, complete_rate: 70, share_rate: 10, last_open_at: '2026-09-21T10:00:00Z', trend: [{ day: '2026-09-21', openers: 10, completers: 8, sharers: 1 }] },
        grants: { broadcasts: 2, grantedUsers: 30, grantedPlays: 60 }
      }) });
    }
  });
  await new Promise(r => setTimeout(r, 80));
  const doc = dom.window.document;
  assert.equal(doc.getElementById('fn-openers').textContent, '40');
  assert.match(doc.getElementById('fn-complete-rate').textContent, /70%/);
  assert.match(doc.getElementById('funnel-trend').textContent, /09-21/);
  const grant = doc.getElementById('grant-summary');
  assert.equal(grant.hidden, false);
  assert.match(grant.textContent, /2/);
  assert.match(grant.textContent, /60/);
  dom.window.close();

  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/admin/activities/9/players',
    beforeParse(window) { window.fetch = async () => ({ json: async () => ({ ok: true, players: [], overview: {}, funnel: null, grants: null }) }); }
  });
  await new Promise(r => setTimeout(r, 80));
  assert.match(dom2.window.document.getElementById('funnel-meta').textContent, /暫時讀不到/);
  assert.match(dom2.window.document.getElementById('players-tbody').textContent, /尚無玩家/);
  dom2.window.close();
});
