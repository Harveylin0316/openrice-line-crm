const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createLineWebhookHandler } = require('../src/routes/lineWebhook');

const SECRET = 'test-channel-secret';
const INVITER = 'U' + 'c'.repeat(32);
const INVITEE = 'U' + 'd'.repeat(32);

function responseRecorder() {
  return {
    statusCode: 0, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('LINE 驗簽 follow 事件會在同一個 webhook request 內完成正式活動邀請入帳', async () => {
  const referralInserts = [];
  const pool = {
    async query(sql, params = []) {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO users .*RETURNING \(xmax = 0\) AS inserted/.test(flat)) {
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
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
        referralInserts.push(params);
        return { rows: [{ id: 1001 }] };
      }
      if (/COUNT\(\*\) AS c FROM activity_referrals/.test(flat)) return { rows: [{ c: 1 }] };
      if (/INSERT INTO line_push_logs|INSERT INTO activity_referral_attempts|INSERT INTO line_webhook_events/.test(flat)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected pool SQL: ' + flat);
    },
    async connect() {
      return {
        async query(sql) {
          const flat = String(sql).replace(/\s+/g, ' ');
          if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(flat)) return { rows: [], rowCount: 0 };
          if (/FROM line_invites .*FOR UPDATE/.test(flat)) return { rows: [], rowCount: 0 };
          if (/COUNT\(\*\)::int AS c FROM line_invites/.test(flat)) return { rows: [{ c: 0 }], rowCount: 1 };
          throw new Error('Unexpected client SQL: ' + flat);
        },
        release() {}
      };
    }
  };

  const rawBody = Buffer.from(JSON.stringify({ events: [{
    type: 'follow', timestamp: 1788480000000, source: { type: 'user', userId: INVITEE }
  }] }));
  const signature = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');
  const req = { body: rawBody, get: (name) => name.toLowerCase() === 'x-line-signature' ? signature : '' };
  const res = responseRecorder();
  const oldToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  try {
    const handler = createLineWebhookHandler({
      pool, channelSecret: SECRET, inviteBonusMax: 0, inviteFriendsPerDraw: 1, linePush: null
    });
    await handler(req, res);
  } finally {
    if (oldToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = oldToken;
  }

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(referralInserts, [[6, INVITER, INVITEE, false]]);
});

test('沒有合法 LINE 簽章的請求不能觸發好友入帳', async () => {
  let queryCalls = 0;
  const handler = createLineWebhookHandler({
    pool: { query: async () => { queryCalls++; return { rows: [] }; } },
    channelSecret: SECRET, linePush: null
  });
  const res = responseRecorder();
  await handler({ body: Buffer.from('{"events":[]}'), get: () => 'bad-signature' }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(queryCalls, 0);
});
