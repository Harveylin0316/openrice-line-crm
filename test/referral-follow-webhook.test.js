const test = require('node:test');
const assert = require('node:assert/strict');

const {
  completePendingActivityReferralsForFollow
} = require('../src/core/activityReferralFollow');

const INVITER = 'U' + 'a'.repeat(32);
const INVITEE = 'U' + 'b'.repeat(32);

test('follow webhook 會立即補完先前尚未加好友的活動邀請', async () => {
  const inserts = [];
  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    if (/SELECT DISTINCT ON \(att\.activity_slug/.test(flat)) {
      assert.deepEqual(params, [INVITEE, 72]);
      assert.match(flat, /att\.outcome = 'invitee_not_follower'/);
      assert.match(flat, /ORDER BY att\.activity_slug, att\.game_type, att\.created_at DESC/);
      return { rows: [{
        activity_slug: 'share-miles', game_type: 'mgm',
        inviter_line_user_id: INVITER, created_at: new Date()
      }] };
    }
    if (/FROM activities WHERE slug/.test(flat)) return { rows: [{
      id: 6, status: 'active', start_at: null, end_at: null,
      referral_bonus_per: 1, referral_bonus_max: 3,
      referral_invites_per_bonus: 1, liff_id_override: null
    }] };
    if (/SELECT 1 FROM users WHERE line_user_id/.test(flat)) return { rows: [{}] };
    if (/AS was_existing/.test(flat)) return { rows: [{ was_existing: false }] };
    if (/INSERT INTO activity_referrals/.test(flat)) {
      inserts.push({ type: 'referral', params });
      return { rows: [{ id: 901 }] };
    }
    if (/INSERT INTO activity_referral_attempts/.test(flat)) {
      inserts.push({ type: 'audit', params });
      return { rows: [] };
    }
    throw new Error('Unexpected SQL: ' + flat);
  };

  // 沒有 LINE profile API 也必須成功：follow webhook 已是簽章驗證過的好友事件。
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error('profile API should not be called'); };
  let countedHook = 0;
  try {
    const completed = await completePendingActivityReferralsForFollow({
      query,
      inviteeId: INVITEE,
      onCounted: async () => { countedHook++; }
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].result.ok, true);
    assert.equal(completed[0].result.counted, true);
    assert.equal(completed[0].result.invitee_was_existing, false);
    assert.equal(countedHook, 1);
    assert.deepEqual(inserts.find((x) => x.type === 'referral').params, [6, INVITER, INVITEE, false]);
    assert.equal(inserts.find((x) => x.type === 'audit').params[4], 'counted_by_follow_webhook');
  } finally {
    global.fetch = oldFetch;
  }
});

test('沒有待處理邀請時，follow webhook 不會憑空加次數', async () => {
  let calls = 0;
  const completed = await completePendingActivityReferralsForFollow({
    query: async () => { calls++; return { rows: [] }; },
    inviteeId: INVITEE
  });
  assert.deepEqual(completed, []);
  assert.equal(calls, 1);
});
