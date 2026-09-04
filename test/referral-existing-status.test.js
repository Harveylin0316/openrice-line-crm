const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

const { registerReferral } = require(path.join(__dirname, '..', 'src/core/gamePlayEngine'));

const INVITER = 'U' + 'a'.repeat(32);
const INVITEE = 'U' + 'b'.repeat(32);

function fakeQuery({ firstSeenAt, notFollowerAttemptAt }) {
  const inserted = [];
  const sqlSeen = [];
  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    sqlSeen.push(flat);

    if (/FROM activities WHERE slug/.test(flat)) {
      return { rows: [{
        id: 6, status: 'active', start_at: null, end_at: null,
        referral_bonus_per: 1, referral_bonus_max: 3,
        referral_invites_per_bonus: 1, liff_id_override: null
      }] };
    }
    if (/SELECT 1 FROM users WHERE line_user_id/.test(flat)) return { rows: [{}] };
    if (/AS was_existing/.test(flat)) {
      assert.match(flat, /FROM activity_referral_attempts att/);
      assert.match(flat, /att\.outcome = 'invitee_not_follower'/);
      assert.match(flat, /att\.created_at <= first_seen_at/);
      assert.deepEqual(params, [INVITEE, 'share-miles', 'mgm', INVITER]);

      const firstSeen = firstSeenAt == null ? null : new Date(firstSeenAt).getTime();
      const attempted = notFollowerAttemptAt == null ? null : new Date(notFollowerAttemptAt).getTime();
      const wasExisting = firstSeen !== null && !(attempted !== null && attempted <= firstSeen);
      return { rows: [{ was_existing: wasExisting }] };
    }
    if (/INSERT INTO activity_referrals/.test(flat)) {
      inserted.push(params);
      return { rows: [{ id: 901 }] };
    }
    return { rows: [] };
  };
  return { query, inserted, sqlSeen };
}

async function runCase(state) {
  const db = fakeQuery(state);
  const oldFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ displayName: 'Josh' }) });
  try {
    const result = await registerReferral({
      query: db.query,
      activitySlug: 'share-miles',
      gameType: 'mgm',
      inviterId: INVITER,
      inviteeId: INVITEE
    });
    return { ...db, result };
  } finally {
    global.fetch = oldFetch;
  }
}

test('新朋友先被確認未加好友，follow 建會員後仍算新朋友', async () => {
  const out = await runCase({
    notFollowerAttemptAt: '2026-09-04T12:08:38+08:00',
    firstSeenAt: '2026-09-04T12:08:55+08:00'
  });

  assert.equal(out.result.ok, true);
  assert.equal(out.result.invitee_was_existing, false);
  assert.equal(out.inserted.length, 1);
  assert.equal(out.inserted[0][3], false);
});

test('真正既有會員即使重新加好友也維持不計數', async () => {
  const out = await runCase({
    firstSeenAt: '2026-07-29T18:22:08+08:00',
    notFollowerAttemptAt: '2026-09-04T12:08:38+08:00'
  });

  assert.equal(out.result.invitee_was_existing, true);
  assert.equal(out.inserted[0][3], true);
});

test('會員表完全沒有這個人時，成功 follow 應算新朋友', async () => {
  const out = await runCase({ firstSeenAt: null, notFollowerAttemptAt: null });

  assert.equal(out.result.invitee_was_existing, false);
  assert.equal(out.inserted[0][3], false);
});
