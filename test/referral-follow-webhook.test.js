const test = require('node:test');
const assert = require('node:assert/strict');

const {
  completePendingActivityReferralsForFollow,
  retryTransient
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
      assert.match(flat, /ORDER BY att\.activity_slug, att\.game_type, att\.created_at DESC, att\.id DESC/);
      return { rows: [{
        activity_slug: 'share-miles', game_type: 'wheel',
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
    if (/COUNT\(\*\) AS c FROM activity_referrals/.test(flat)) {
      assert.match(flat, /invitee_was_existing IS FALSE/);
      return { rows: [{ c: 1 }] };
    }
    if (/INSERT INTO line_push_logs/.test(flat)) {
      inserts.push({ type: 'push_log', params });
      return { rows: [] };
    }
    if (/INSERT INTO activity_referral_attempts/.test(flat)) {
      inserts.push({ type: 'audit', params });
      return { rows: [] };
    }
    throw new Error('Unexpected SQL: ' + flat);
  };

  // 沒有 LINE profile API 也必須成功：follow webhook 已是簽章驗證過的好友事件。
  const oldFetch = global.fetch;
  const oldToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
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
    if (oldToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = oldToken;
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

test('follow 查詢碰到短暫資料庫錯誤會在 webhook 內自動重試', async () => {
  let attempts = 0;
  const answer = await retryTransient(async () => {
    attempts++;
    if (attempts < 3) throw new Error('temporary connection reset');
    return 'ok';
  });
  assert.equal(answer, 'ok');
  assert.equal(attempts, 3);
});

test('webhook 與瀏覽器同時補登時，唯一鍵競態不會重複計次或重複通知', async () => {
  let referralInsertCalls = 0;
  let notifyQueries = 0;
  const query = async (sql) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    if (/SELECT DISTINCT ON \(att\.activity_slug/.test(flat)) return { rows: [{
      activity_slug: 'share-miles', game_type: 'wheel',
      inviter_line_user_id: INVITER, created_at: new Date()
    }] };
    if (/FROM activities WHERE slug/.test(flat)) return { rows: [{
      id: 6, status: 'active', start_at: null, end_at: null,
      referral_bonus_per: 1, referral_bonus_max: 3,
      referral_invites_per_bonus: 1, liff_id_override: null
    }] };
    if (/SELECT 1 FROM users WHERE line_user_id/.test(flat)) return { rows: [{}] };
    if (/AS was_existing/.test(flat)) return { rows: [{ was_existing: false }] };
    if (/INSERT INTO activity_referrals/.test(flat)) {
      referralInsertCalls++;
      return { rows: [] }; // 另一條請求已先寫入
    }
    if (/SELECT inviter_line_user_id FROM activity_referrals/.test(flat)) {
      return { rows: [{ inviter_line_user_id: INVITER }] };
    }
    if (/COUNT\(\*\) AS c FROM activity_referrals|INSERT INTO line_push_logs/.test(flat)) {
      notifyQueries++;
      return { rows: [{ c: 1 }] };
    }
    if (/INSERT INTO activity_referral_attempts/.test(flat)) return { rows: [] };
    throw new Error('Unexpected SQL: ' + flat);
  };

  const completed = await completePendingActivityReferralsForFollow({ query, inviteeId: INVITEE });
  assert.equal(referralInsertCalls, 1);
  assert.equal(completed[0].result.counted, false);
  assert.equal(completed[0].result.same_inviter, true);
  assert.equal(notifyQueries, 0);
});

test('新舊好友判定短暫失敗時不會寫入永久無法補救的 NULL 邀請', async () => {
  let existingChecks = 0;
  const referralParams = [];
  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    if (/SELECT DISTINCT ON \(att\.activity_slug/.test(flat)) return { rows: [{
      activity_slug: 'share-miles', game_type: 'wheel',
      inviter_line_user_id: INVITER, created_at: new Date()
    }] };
    if (/FROM activities WHERE slug/.test(flat)) return { rows: [{
      id: 6, status: 'active', start_at: null, end_at: null,
      referral_bonus_per: 1, referral_bonus_max: 3,
      referral_invites_per_bonus: 1, liff_id_override: null
    }] };
    if (/SELECT 1 FROM users WHERE line_user_id/.test(flat)) return { rows: [{}] };
    if (/AS was_existing/.test(flat)) {
      existingChecks++;
      if (existingChecks === 1) throw new Error('temporary read failure');
      return { rows: [{ was_existing: false }] };
    }
    if (/INSERT INTO activity_referrals/.test(flat)) {
      referralParams.push(params);
      return { rows: [{ id: 902 }] };
    }
    if (/COUNT\(\*\) AS c FROM activity_referrals/.test(flat)) return { rows: [{ c: 1 }] };
    if (/INSERT INTO line_push_logs|INSERT INTO activity_referral_attempts/.test(flat)) return { rows: [] };
    throw new Error('Unexpected SQL: ' + flat);
  };

  const oldToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  try {
    const completed = await completePendingActivityReferralsForFollow({ query, inviteeId: INVITEE });
    assert.equal(existingChecks, 2);
    assert.deepEqual(referralParams, [[6, INVITER, INVITEE, false]]);
    assert.equal(completed[0].result.counted, true);
  } finally {
    if (oldToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = oldToken;
  }
});

test('待處理邀請採每個活動最後點擊，且只接受 72 小時內尚未入帳的紀錄', async () => {
  let capturedSql = '';
  let capturedParams = null;
  await completePendingActivityReferralsForFollow({
    query: async (sql, params) => {
      capturedSql = String(sql).replace(/\s+/g, ' ');
      capturedParams = params;
      return { rows: [] };
    },
    inviteeId: INVITEE
  });
  assert.match(capturedSql, /DISTINCT ON \(att\.activity_slug, att\.game_type\)/);
  assert.match(capturedSql, /att\.created_at >= now\(\) -/);
  assert.match(capturedSql, /NOT EXISTS/);
  assert.match(capturedSql, /ORDER BY att\.activity_slug, att\.game_type, att\.created_at DESC, att\.id DESC/);
  assert.deepEqual(capturedParams, [INVITEE, 72]);
});
