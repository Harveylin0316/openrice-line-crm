// 後台 MGM「查一個人」（客服用）必須跟玩家實際能玩的次數同一份公式。
//
// 這支曾經自己手寫一套：漏了 activity_user_quotas 的個別配額（override 是「取代」
// 基本＋邀請，不是加上去），base 預設值也跟引擎不同（|| 0 vs || 1）。
// 結果客服看到的數字跟玩家實際能玩的對不起來——跟 8/18 修的是同一種病。
const assert = require('node:assert');
const { test } = require('node:test');
const REPO = require('path').join(__dirname, '..');
const eng = require(REPO + '/src/core/gamePlayEngine.js');
const { registerMgmMilesRoutes } = require(REPO + '/src/routes/mgmMiles.js');

const ACT = { id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active' };

function makeQuery(st) {
  return async (sql) => {
    const f = String(sql).replace(/\s+/g, ' ');
    if (/FROM activities/.test(f)) return { rows: [{ ...ACT,
      start_at: null, end_at: null, rules: {},
      base_plays_per_user: st.base, referral_bonus_per: st.per,
      referral_bonus_max: st.max, referral_invites_per_bonus: st.invitesPer }] };
    if (/activity_user_quotas/.test(f))
      return { rows: st.override == null ? [] : [{ max_plays_override: st.override, note: '客服補的' }] };
    if (/FROM users WHERE line_user_id/.test(f))
      return { rows: [{ display_name: '測試人', created_at: null, blocked_at: null, archived_at: null }] };
    // 注意：欄位別名同時給新舊兩種寫法，假資料庫對兩版程式都成立——
    // 否則舊版是「跑不起來」而不是「算錯」，這支測試就證明不了任何事。
    if (/COUNT\(\*\)(::int)? AS c FROM activity_plays/.test(f)) {
      // draw_win = 後台大獎抽獎寫進來的，不佔次數
      return { rows: [{ c: st.played + (/draw_win/.test(f) ? 0 : st.drawWins) }] };
    }
    if (/FROM activity_referrals/.test(f) && /COUNT/.test(f))
      return { rows: [{ c: st.newFriends, new_friends: st.newFriends,
                        existing: st.oldFriends, existing_friends: st.oldFriends }] };
    if (/activity_bonus_plays/.test(f) && /SUM\(plays\)/.test(f))
      return { rows: [{ b: st.manualBonus }] };
    return { rows: [] };
  };
}

// 把路由掛進假的 app，取出 /admin/mgm/api/user 的 handler
function getLookupHandler(query) {
  let handler = null;
  const app = {
    get(path, ...fns) { if (path === '/admin/mgm/api/user') handler = fns[fns.length - 1]; },
    post() {}, use() {}
  };
  registerMgmMilesRoutes(app, {
    query,
    authCore: { requireAdmin: (_q, _s, n) => n && n(), requireOwner: (_q, _s, n) => n && n() },
    mgmEngine: {}, defaultLiffId: 'x'
  });
  assert.ok(handler, '沒有掛上 /admin/mgm/api/user');
  return handler;
}

async function lookup(st) {
  const query = makeQuery(st);
  const handler = getLookupHandler(query);
  let body = null;
  const res = { json(b) { body = b; return b; }, status() { return res; } };
  await handler({ query: { q: 'U'.padEnd(33, 'a'), activity_id: 6 } }, res);
  assert.ok(body && body.ok, '查詢失敗：' + JSON.stringify(body));
  return body;
}

const CASES = [
  { n: '沒有個別配額：基本 1 ＋ 邀請 2',
    base: 1, per: 1, max: 2, invitesPer: 1, newFriends: 2, oldFriends: 0,
    manualBonus: 0, override: null, played: 0, drawWins: 0, want: 3 },
  { n: '有個別配額 5：取代基本＋邀請，不是加上去',
    base: 1, per: 1, max: 2, invitesPer: 1, newFriends: 2, oldFriends: 0,
    manualBonus: 0, override: 5, played: 0, drawWins: 0, want: 5 },
  { n: '個別配額 5 ＋ 人工補 2：加碼永遠外加',
    base: 1, per: 1, max: 2, invitesPer: 1, newFriends: 2, oldFriends: 0,
    manualBonus: 2, override: 5, played: 0, drawWins: 0, want: 7 },
  { n: '既有好友不算次數（防洗）',
    base: 1, per: 1, max: 2, invitesPer: 1, newFriends: 0, oldFriends: 3,
    manualBonus: 0, override: null, played: 0, drawWins: 0, want: 1 },
  { n: 'base 沒設（NULL）時預設 1，不是 0',
    base: null, per: 1, max: 2, invitesPer: 1, newFriends: 0, oldFriends: 0,
    manualBonus: 0, override: null, played: 0, drawWins: 0, want: 1 },
  { n: '被後台抽中大獎：不佔已玩次數',
    base: 1, per: 1, max: 2, invitesPer: 1, newFriends: 0, oldFriends: 0,
    manualBonus: 0, override: null, played: 1, drawWins: 2, want: 1 },
];

for (const c of CASES) {
  test('客服查詢與引擎一致 — ' + c.n, async () => {
    const body = await lookup(c);
    const q = await eng.computeUserQuota(makeQuery(c), {
      id: ACT.id, base_plays_per_user: c.base, referral_bonus_per: c.per,
      referral_bonus_max: c.max, referral_invites_per_bonus: c.invitesPer
    }, 'U1');

    assert.strictEqual(body.quota.total, c.want, '總次數不符預期');
    assert.strictEqual(body.quota.total, q.total, '客服看到的總次數 ≠ 引擎算的');
    assert.strictEqual(body.quota.played, q.played, '已玩次數對不起來');
    assert.strictEqual(body.quota.remaining, q.remaining, '剩餘次數對不起來');
    assert.strictEqual(body.quota.new_friends, q.referrals, '新朋友數對不起來');
    assert.strictEqual(body.quota.existing_friends, q.referrals_existing, '既有好友數對不起來');
    assert.strictEqual(body.quota.manual_bonus, q.bonus_plays, '人工補發對不起來');

    // 個別配額必須原樣帶到畫面，否則「基本＋邀請＝總共」那行會加不起來
    if (c.override != null) {
      assert.ok(body.quota.override, '有個別配額卻沒回傳 override');
      assert.strictEqual(body.quota.override.max_plays, c.override);
      assert.strictEqual(body.quota.total, c.override + c.manualBonus,
        'override 應該取代基本＋邀請，加碼才外加');
    } else {
      assert.strictEqual(body.quota.override, null, '沒有個別配額時 override 應為 null');
    }
  });
}
