// 只讀人工複核清單。沒有 UPDATE referral／發獎／推播路徑。
const REVIEW_SQL = `WITH historical AS (
  SELECT r.id AS referral_id, r.inviter_line_user_id AS inviter_uid,
    r.invitee_line_user_id AS invitee_uid, r.created_at AS attempted_at,
    u.created_at AS first_seen_at, f.event_timestamp AS followed_at,
    'legacy_existing'::text AS reason
  FROM activity_referrals r JOIN users u ON u.line_user_id=r.invitee_line_user_id
  JOIN LATERAL (
    SELECT event_timestamp, raw_event FROM line_webhook_events e
    WHERE e.line_user_id=r.invitee_line_user_id AND e.event_type='follow'
    ORDER BY event_timestamp ASC NULLS LAST LIMIT 1
  ) f ON TRUE
  WHERE r.activity_id=$1 AND r.invitee_was_existing IS TRUE
    AND u.created_at BETWEEN r.created_at - INTERVAL '30 minutes' AND r.created_at
    AND f.event_timestamp BETWEEN r.created_at - INTERVAL '30 minutes' AND r.created_at
    AND f.raw_event->'follow'->>'isUnblocked'='false'
    AND NOT EXISTS (SELECT 1 FROM line_webhook_events prior
      WHERE prior.line_user_id=r.invitee_line_user_id AND prior.event_type='unfollow'
        AND prior.event_timestamp < f.event_timestamp)
), pending AS (
  SELECT DISTINCT ON (t.invitee_line_user_id) NULL::bigint AS referral_id,
    t.inviter_line_user_id AS inviter_uid, t.invitee_line_user_id AS invitee_uid,
    t.created_at AS attempted_at, u.created_at AS first_seen_at,
    NULL::timestamptz AS followed_at, 'eligibility_pending'::text AS reason
  FROM activity_referral_attempts t LEFT JOIN users u ON u.line_user_id=t.invitee_line_user_id
  WHERE t.activity_slug=$2 AND t.game_type=$3 AND t.outcome='invitee_status_unavailable'
    AND t.invitee_line_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM activity_referrals r
      WHERE r.activity_id=$1 AND r.invitee_line_user_id=t.invitee_line_user_id)
  ORDER BY t.invitee_line_user_id,t.created_at DESC,t.id DESC
), review AS (
  SELECT r.*, COALESCE(ui.line_display_name,'(沒有名字)') AS inviter_name,
    COALESCE(uv.line_display_name,'(沒有名字)') AS invitee_name
  FROM (SELECT * FROM historical UNION ALL SELECT * FROM pending) r
  LEFT JOIN users ui ON ui.line_user_id=r.inviter_uid
  LEFT JOIN users uv ON uv.line_user_id=r.invitee_uid
  WHERE NOT (EXISTS (SELECT 1 FROM admin_test_recipients WHERE line_user_id=r.inviter_uid)
    AND EXISTS (SELECT 1 FROM admin_test_recipients WHERE line_user_id=r.invitee_uid))
) SELECT (SELECT COUNT(*)::int FROM review) AS total,
  (SELECT COUNT(*)::int FROM review WHERE reason='legacy_existing') AS historical_count,
  (SELECT COUNT(*)::int FROM review WHERE reason='eligibility_pending') AS pending_count,
  (SELECT COALESCE(JSON_AGG(x ORDER BY attempted_at DESC),'[]'::json)
    FROM (SELECT * FROM review ORDER BY attempted_at DESC LIMIT 5000) x) AS candidates`;

async function loadReferralReview(query, activity) {
  return (await query(REVIEW_SQL, [activity.id, activity.slug, activity.game_type])).rows[0] || {};
}
module.exports = { REVIEW_SQL, loadReferralReview };
