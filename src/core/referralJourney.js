const crypto = require('node:crypto');

const PROOF_RE = /^([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{43})$/;
const TTL_HOURS = 72;
function proofHash(nonce) { return 'journey_open:' + crypto.createHash('sha256').update(nonce).digest('hex'); }

// 在 LINE 同意／加入好友畫面之前由伺服器記錄；不是活動 enter，也不增加次數。
async function createReferralJourney({ query, slug, gameType, inviterId }) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const { rows } = await query(`INSERT INTO activity_referral_attempts
    (activity_slug, game_type, inviter_line_user_id, invitee_line_user_id, outcome)
    VALUES ($1,$2,$3,NULL,$4) RETURNING id`, [slug, gameType, inviterId, proofHash(nonce)]);
  if (!rows[0]) throw new Error('journey_create_failed');
  return String(rows[0].id) + '.' + nonce;
}

// 僅能在 LINE id token 已驗證之後呼叫。單筆 UPDATE 的鎖保護跨帳號同時重放。
async function claimReferralJourney({ query, proof, slug, gameType, inviterId, inviteeId }) {
  const match = PROOF_RE.exec(String(proof || ''));
  if (!match || BigInt(match[1]) > 9223372036854775807n) return null;
  const { rows } = await query(`UPDATE activity_referral_attempts
    SET invitee_line_user_id = $5
    WHERE id = $1 AND outcome = $2 AND activity_slug = $3 AND game_type = $4
      AND inviter_line_user_id = $6
      AND created_at >= now() - ($7::text || ' hours')::interval
      AND created_at <= now()
      AND (invitee_line_user_id IS NULL OR invitee_line_user_id = $5)
    RETURNING LEAST(created_at, (SELECT MIN(j.created_at) FROM activity_referral_attempts j
      WHERE j.activity_slug=$3 AND j.game_type=$4 AND j.invitee_line_user_id=$5
        AND j.inviter_line_user_id=$6 AND j.outcome LIKE 'journey_open:%'
        AND j.created_at >= now() - ($7::text || ' hours')::interval)) AS created_at`,
    [match[1], proofHash(match[2]), slug, gameType, inviteeId, inviterId, TTL_HOURS]);
  return rows[0] ? rows[0].created_at : null;
}

// 當下 webhook 尚未寫入 log 時，僅接受內部已驗簽事件，不接受 HTTP body 的時間或旗標。
async function detectJourneyExisting({ query, inviteeId, startedAt, followEvidence = null }) {
  const { rows } = await query(`WITH member AS (
      SELECT MIN(created_at) AS first_seen_at FROM users WHERE line_user_id = $1
    ), follows AS (
      SELECT event_timestamp AS at, raw_event->'follow'->>'isUnblocked' AS unblocked
        FROM line_webhook_events WHERE line_user_id = $1 AND event_type = 'follow'
      UNION ALL SELECT $3::timestamptz, $4::text WHERE $3::timestamptz IS NOT NULL
    ) SELECT CASE
      WHEN EXISTS (SELECT 1 FROM line_webhook_events WHERE line_user_id = $1
        AND event_type IN ('follow','unfollow','message','postback') AND event_timestamp < $2::timestamptz)
        OR EXISTS (SELECT 1 FROM follows WHERE at >= $2::timestamptz AND unblocked = 'true') THEN TRUE
      WHEN (SELECT first_seen_at FROM member) < $2::timestamptz THEN NULL
      WHEN EXISTS (SELECT 1 FROM follows WHERE at >= $2::timestamptz AND at <= now()
        AND unblocked = 'false') THEN FALSE
      ELSE NULL END AS was_existing`, [inviteeId, startedAt,
      followEvidence && followEvidence.at || null,
      followEvidence && typeof followEvidence.isUnblocked === 'boolean' ? String(followEvidence.isUnblocked) : null]);
  return rows[0] && typeof rows[0].was_existing === 'boolean' ? rows[0].was_existing : null;
}

module.exports = { PROOF_RE, TTL_HOURS, createReferralJourney, claimReferralJourney, detectJourneyExisting };
