/**
 * 收到 LINE follow webhook 時，立即補完使用者在加好友前留下的活動邀請。
 *
 * 背景：遊戲頁在發現被邀請人尚未加 OA 時，會把 invitee_not_follower 寫進
 * activity_referral_attempts。若只等瀏覽器重查，使用者就必須關閉加好友視窗或按
 * 「我加好了」；改由 webhook 接手後，按下加入好友的當下就能入帳。
 */
const { registerReferral } = require('./gamePlayEngine');

const PENDING_TTL_HOURS = 72;

async function completePendingActivityReferralsForFollow({ query, inviteeId, onCounted = null }) {
  if (!query || !inviteeId) return [];

  // 同一檔活動若開過不只一個人的分享連結，採最後一次有效點擊（last touch）。
  // 已入帳的活動不再處理；UNIQUE(activity_id, invitee_line_user_id) 仍是最後一道併發保護。
  const { rows } = await query(
    `SELECT DISTINCT ON (att.activity_slug, att.game_type)
            att.activity_slug, att.game_type, att.inviter_line_user_id, att.created_at
       FROM activity_referral_attempts att
      WHERE att.invitee_line_user_id = $1
        AND att.outcome = 'invitee_not_follower'
        AND att.created_at >= now() - ($2::text || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1
            FROM activities a
            JOIN activity_referrals r ON r.activity_id = a.id
           WHERE a.slug = att.activity_slug
             AND a.game_type = att.game_type
             AND r.invitee_line_user_id = $1
        )
      ORDER BY att.activity_slug, att.game_type, att.created_at DESC
      LIMIT 12`,
    [inviteeId, PENDING_TTL_HOURS]
  );

  const completed = [];
  for (const pending of rows || []) {
    let result;
    try {
      result = await registerReferral({
        query,
        activitySlug: pending.activity_slug,
        gameType: pending.game_type,
        inviterId: pending.inviter_line_user_id,
        inviteeId,
        followConfirmed: true
      });
    } catch (error) {
      result = { error: { code: 'server_error', detail: String(error && error.message || error) } };
    }

    const outcome = result && result.error
      ? result.error.code || 'server_error'
      : result && result.counted ? 'counted_by_follow_webhook' : 'duplicate_by_follow_webhook';
    try {
      await query(
        `INSERT INTO activity_referral_attempts
          (activity_slug, game_type, inviter_line_user_id, invitee_line_user_id, outcome)
         VALUES ($1, $2, $3, $4, $5)`,
        [pending.activity_slug, pending.game_type, pending.inviter_line_user_id, inviteeId, outcome]
      );
    } catch (error) {
      console.error('follow referral attempt log failed:', error && error.message);
    }

    const item = {
      activitySlug: pending.activity_slug,
      gameType: pending.game_type,
      inviterId: pending.inviter_line_user_id,
      result
    };
    completed.push(item);
    if (result && result.counted && typeof onCounted === 'function') {
      try { await onCounted(item); }
      catch (error) { console.error('follow referral counted hook failed:', error && error.message); }
    }
  }
  return completed;
}

module.exports = { completePendingActivityReferralsForFollow, PENDING_TTL_HOURS };
