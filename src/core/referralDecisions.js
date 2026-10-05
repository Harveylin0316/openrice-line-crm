const { computeQuotaNumbers } = require('./gamePlayEngine');

// Only server-recorded, identity-bound journeys / verified non-follower attempts
// followed by a first signed follow event qualify. Proximity alone never does.
const DECISION_SQL = `WITH pairs AS (
 SELECT inviter_line_user_id AS inviter_uid, invitee_line_user_id AS invitee_uid,
   MIN(created_at) AS attempted_at
 FROM activity_referral_attempts
 WHERE activity_slug=$2 AND game_type=$3 AND invitee_line_user_id IS NOT NULL
   AND inviter_line_user_id IS NOT NULL AND ($4::text IS NULL OR invitee_line_user_id=$4)
 GROUP BY inviter_line_user_id,invitee_line_user_id
 UNION
 SELECT inviter_line_user_id,invitee_line_user_id,created_at FROM activity_referrals
 WHERE activity_id=$1 AND ($4::text IS NULL OR invitee_line_user_id=$4)
), unique_pairs AS (
 SELECT inviter_uid,invitee_uid,MIN(attempted_at) AS attempted_at FROM pairs
 GROUP BY inviter_uid,invitee_uid
)
SELECT p.*, r.id AS referral_id, r.inviter_line_user_id AS recorded_inviter,
 r.invitee_was_existing AS was_existing,
 COALESCE(ui.line_display_name,'(沒有名字)') AS inviter_name,
 COALESCE(uv.line_display_name,'(沒有名字)') AS invitee_name,
 uv.created_at AS first_seen_at, f.event_timestamp AS followed_at,
 (ui.id IS NOT NULL AND ui.archived_at IS NULL AND ui.blocked_at IS NULL) AS inviter_valid,
 (uv.id IS NOT NULL AND uv.archived_at IS NULL AND uv.blocked_at IS NULL) AS invitee_valid,
 f.raw_event->'follow'->>'isUnblocked' AS is_unblocked,
 proof.created_at AS proof_at,
 EXISTS(SELECT 1 FROM line_webhook_events old WHERE old.line_user_id=p.invitee_uid
   AND old.event_type IN ('follow','unfollow','message','postback')
   AND old.event_timestamp < proof.created_at) AS prior_friend_evidence,
 EXISTS(SELECT 1 FROM unique_pairs other WHERE other.invitee_uid=p.invitee_uid
   AND other.inviter_uid<>p.inviter_uid) AS competing_inviter,
 (SELECT COUNT(*)::int FROM activity_referrals n WHERE n.activity_id=$1
   AND n.inviter_line_user_id=p.inviter_uid AND n.invitee_was_existing IS FALSE) AS current_new_friends,
 EXISTS(SELECT 1 FROM activity_bonus_plays b WHERE b.activity_id=$1
   AND b.line_user_id=p.inviter_uid AND b.plays>0) AS has_manual_bonus,
 EXISTS(SELECT 1 FROM activity_user_quotas q WHERE q.activity_id=$1
   AND q.line_user_id=p.inviter_uid AND q.max_plays_override IS NOT NULL) AS has_override
FROM unique_pairs p
LEFT JOIN activity_referrals r ON r.activity_id=$1 AND r.invitee_line_user_id=p.invitee_uid
LEFT JOIN users ui ON ui.line_user_id=p.inviter_uid
LEFT JOIN users uv ON uv.line_user_id=p.invitee_uid
LEFT JOIN LATERAL (SELECT event_timestamp,raw_event FROM line_webhook_events
 WHERE line_user_id=p.invitee_uid AND event_type='follow'
 ORDER BY event_timestamp ASC NULLS LAST LIMIT 1) f ON TRUE
LEFT JOIN LATERAL (SELECT created_at FROM activity_referral_attempts t
 WHERE t.activity_slug=$2 AND t.game_type=$3 AND t.inviter_line_user_id=p.inviter_uid
   AND t.invitee_line_user_id=p.invitee_uid
   AND (t.outcome='invitee_not_follower' OR t.outcome LIKE 'journey_open:%')
   AND t.created_at <= f.event_timestamp
   AND t.created_at >= f.event_timestamp - INTERVAL '72 hours'
 ORDER BY created_at ASC LIMIT 1) proof ON TRUE
WHERE NOT (EXISTS(SELECT 1 FROM admin_test_recipients WHERE line_user_id=p.inviter_uid)
 AND EXISTS(SELECT 1 FROM admin_test_recipients WHERE line_user_id=p.invitee_uid))
ORDER BY p.attempted_at DESC,p.inviter_uid,p.invitee_uid LIMIT 5001`;

function assess(row, activity, now = Date.now()) {
  const result = (decision, explanation, extra = 0, repairable = false) =>
    ({ ...row, decision, explanation, extra_chances: extra, repairable });
  if (row.recorded_inviter && row.recorded_inviter !== row.inviter_uid)
    return result('no_action', '已歸屬另一位邀請人，不能重複計入。');
  if (row.referral_id && row.was_existing === false)
    return result('no_action', '已計入合格新好友；次數由系統即時計算，不需再補。');
  if (row.inviter_uid === row.invitee_uid)
    return result('no_action', '自己邀請自己不符合資格。');
  if (row.is_unblocked === 'true' || row.prior_friend_evidence === true)
    return result('no_action', '有既有好友或解除封鎖證據，不符合新好友加碼。');
  if (!row.proof_at || !row.followed_at || row.is_unblocked !== 'false' ||
      row.competing_inviter || !row.inviter_valid || !row.invitee_valid ||
      !row.first_seen_at || !Number.isFinite(Date.parse(row.first_seen_at)) ||
      Date.parse(row.first_seen_at) > now || Date.parse(row.first_seen_at) < Date.parse(row.proof_at))
    return result('insufficient', '歷史證據不足，無法確認邀請帶來的新好友；請勿據此補發。');
  const proof = Date.parse(row.proof_at), followed = Date.parse(row.followed_at);
  const start = activity.start_at ? Date.parse(activity.start_at) : -Infinity;
  const end = activity.end_at ? Date.parse(activity.end_at) : Infinity;
  if (![proof, followed].every(Number.isFinite) || proof > followed || followed > now ||
      followed - proof > 72 * 3600000 || proof < start || followed > end)
    return result('no_action', '邀請／加好友時間不符合活動期間或旅程有效期限。');
  if (activity.game_type === 'mgm' || row.has_manual_bonus || row.has_override)
    return result('insufficient', '有其他加碼／個別配額或里程碑規則，須核對既有補償，避免重複補發。');
  const config = { refPer: Number(activity.referral_bonus_per || 0),
    refMax: Number(activity.referral_bonus_max || 0),
    invitesPer: Math.max(1, Number(activity.referral_invites_per_bonus || 1)) };
  if (!Object.values(config).every(Number.isFinite) || config.refPer <= 0 || config.refMax <= 0)
    return result('no_action', '活動未啟用邀請加碼，不能補次數。');
  const count = Math.max(0, Number(row.current_new_friends || 0));
  const extra = computeQuotaNumbers({ ...config, newFriends: count + 1 }).referral_bonus -
    computeQuotaNumbers({ ...config, newFriends: count }).referral_bonus;
  if (activity.status !== 'active' || now < start || now > end)
    return result('no_action', '活動尚未開始或已結束，不能新增可玩次數。');
  return result('needs_repair', extra > 0
    ? '已確認邀請前非好友／有效旅程，之後首次加好友；邀請未正確入帳。'
    : '新好友資格已確認，但目前已達上限或尚未達兌換門檻；修正入帳不會立即增加次數。', extra, true);
}

async function loadDecisions(query, activity, invitee = null) {
  const rows = (await query(DECISION_SQL, [activity.id, activity.slug, activity.game_type, invitee])).rows;
  const candidates = rows.slice(0, 5000).map(row => assess(row, activity));
  return { candidates, truncated: rows.length > 5000,
    counts: candidates.reduce((c, row) => { c[row.decision]++; return c; },
      { needs_repair: 0, no_action: 0, insufficient: 0 }) };
}

async function repairReferral(pool, activityId, inviter, invitee, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const activity = (await client.query('SELECT * FROM activities WHERE id=$1 FOR SHARE', [activityId])).rows[0];
    if (!activity) throw new Error('no_activity');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['game-play:' + activity.id + ':' + inviter]);
    const q = client.query.bind(client);
    const decision = (await loadDecisions(q, activity, invitee)).candidates.find(r => r.inviter_uid === inviter);
    if (!decision || !decision.repairable) throw new Error('not_repairable');
    let changed;
    if (decision.referral_id) {
      changed = await q(`UPDATE activity_referrals SET invitee_was_existing=FALSE
        WHERE id=$1 AND activity_id=$2 AND inviter_line_user_id=$3
          AND invitee_line_user_id=$4 AND invitee_was_existing IS NOT FALSE RETURNING id`,
      [decision.referral_id, activity.id, inviter, invitee]);
    } else {
      changed = await q(`INSERT INTO activity_referrals
        (activity_id,inviter_line_user_id,invitee_line_user_id,invitee_was_existing,created_at)
        VALUES($1,$2,$3,FALSE,$4) ON CONFLICT(activity_id,invitee_line_user_id) DO NOTHING RETURNING id`,
      [activity.id, inviter, invitee, decision.followed_at]);
    }
    if (!changed.rows.length) throw new Error('already_changed');
    await q(`INSERT INTO activity_referral_attempts
      (activity_slug,game_type,inviter_line_user_id,invitee_line_user_id,outcome)
      VALUES($1,$2,$3,$4,$5)`, [activity.slug, activity.game_type, inviter, invitee,
      ('admin_reconciled:' + String(actor || 'admin')).slice(0, 60)]);
    await client.query('COMMIT');
    return { ok: true, extra_chances: decision.extra_chances };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { DECISION_SQL, assess, loadDecisions, repairReferral };
