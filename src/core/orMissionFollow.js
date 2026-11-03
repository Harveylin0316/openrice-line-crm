'use strict';

// OR-96496 phase 1: capture only unless an operator explicitly runs the
// staging sender. Never infer OR membership, reward eligibility or completion.
const STAGING_ENDPOINT = 'https://staging-api.openrice.com/v6/api/job/enqueue/user/follow/account';
const LINE_USER_ID = /^U[0-9a-f]{32}$/i;

function stagingCaptureEnabled(env = process.env) {
  return env.APP_ENV === 'staging' && env.SAFE_PREVIEW_MODE === '1' &&
    env.OR_MISSION_FOLLOW_CAPTURE_ENABLED === '1';
}

function normalizeFollow(event) {
  if (event?.type !== 'follow' || event.source?.type !== 'user' ||
      !LINE_USER_ID.test(event.source?.userId || '') ||
      typeof event.webhookEventId !== 'string' || !event.webhookEventId.trim() ||
      event.webhookEventId.length > 200) return null;
  const at = event.timestamp;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 ||
      !Number.isFinite(new Date(at).getTime())) return null;
  return {
    event_id: event.webhookEventId,
    line_user_id: event.source.userId,
    occurred_at: new Date(at).toISOString(),
    is_unblocked: typeof event.follow?.isUnblocked === 'boolean' ? event.follow.isUnblocked : null
  };
}

async function persistWithMissionCapture(query, events, destination) {
  const follows = events.map(normalizeFollow).filter(Boolean);
  // Joining RETURNING means only newly accepted events create notifications:
  // no replays/backfill of old inbox rows when capture is switched on later.
  return query(`WITH saved_inbox AS (
    INSERT INTO line_webhook_inbox(event_id,payload)
    SELECT x->>'webhookEventId',jsonb_build_object('destination',$2::text,'events',jsonb_build_array(x))
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS items(x,ord)
    ORDER BY ord ON CONFLICT(event_id) DO NOTHING RETURNING event_id
  )
  INSERT INTO or_mission_follow_notifications(webhook_event_id,line_user_id,occurred_at,is_unblocked)
  SELECT x->>'event_id',x->>'line_user_id',(x->>'occurred_at')::timestamptz,
         (x->>'is_unblocked')::boolean
  FROM jsonb_array_elements($3::jsonb) x
  JOIN saved_inbox i ON i.event_id=x->>'event_id'
  ON CONFLICT(webhook_event_id) DO NOTHING`,
  [JSON.stringify(events), destination || null, JSON.stringify(follows)]);
}

function buildStagingRequest(lineUserId) {
  if (!LINE_USER_ID.test(lineUserId || '')) throw Error('invalid_line_user_id');
  const url = new URL(STAGING_ENDPOINT);
  url.search = new URLSearchParams({ accountId: '1', accountType: 'openricelinepage', imKey: lineUserId, imTypeId: '130' });
  return url.href;
}

function createStagingSender({ query, fetchFn = globalThis.fetch, env = process.env }) {
  return async id => {
    // No production endpoint/configurable host, no public route or cron caller.
    // Passing this guard is not permission to transmit a real user's identity.
    if (!stagingCaptureEnabled(env) || env.OR_MISSION_STAGING_SEND_ENABLED !== '1') {
      return { status: 'disabled' };
    }
    if (!/^[1-9]\d{0,14}$/.test(String(id))) throw Error('invalid_notification_id');
    const claimed = await query(`UPDATE or_mission_follow_notifications
      SET status='sending',attempts=attempts+1,started_at=now()
      WHERE id=$1 AND status='captured' AND attempts=0
      RETURNING id,line_user_id`, [String(id)]);
    const row = claimed.rows[0];
    if (!row) return { status: 'not_claimed' };
    let status = 'uncertain', reason = 'network_or_timeout', httpStatus = null;
    try {
      const response = await fetchFn(buildStagingRequest(row.line_user_id), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { accept: 'application/json', 'cache-control': 'no-store' }
      });
      httpStatus = response.status;
      // Chris has not supplied the business response contract. 2xx only proves
      // HTTP acceptance, never a completed task, processed job or reward.
      status = httpStatus >= 200 && httpStatus < 300 ? 'http_accepted_unverified' : 'http_rejected';
      reason = status === 'http_accepted_unverified' ? 'awaiting_or_confirmation' : 'http_non_2xx';
      await response.body?.cancel();
    } catch (_error) {
      // Never log the error/URL: the query string contains LINE user ID.
    }
    try {
      const result = await query(`UPDATE or_mission_follow_notifications
        SET status=$2,reason=$3,http_status=$4,finished_at=now()
        WHERE id=$1 AND status='sending' RETURNING id`, [String(id), status, reason, httpStatus]);
      if (result.rowCount !== 1) return { status: 'uncertain', reason: 'record_update_unconfirmed' };
    } catch (_error) {
      // A sending row is deliberately not reset/retried after a crash or DB loss.
      return { status: 'uncertain', reason: 'record_update_unconfirmed' };
    }
    return { status, httpStatus };
  };
}

module.exports = { stagingCaptureEnabled, normalizeFollow, persistWithMissionCapture, buildStagingRequest, createStagingSender };
