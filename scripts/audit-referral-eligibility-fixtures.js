// 印出合成資料的唯讀 SQL；不連 DB、不讀憑證、不修改任何正式資料。
// 可在 BEGIN READ ONLY 中執行，驗證 Postgres 實際判定而非僅靠 mock。
const { detectJourneyExisting } = require('../src/core/referralJourney');
const { detectInviteeWasExisting } = require('../src/core/gamePlayEngine');
async function buildSql() {
  let journeySql, legacySql;
  await detectJourneyExisting({ query: async sql => { journeySql=sql;return {rows:[]}; } });
  await detectInviteeWasExisting({ query: async sql => { legacySql=sql;return {rows:[]}; } });
  journeySql=journeySql.replace(/\$1\b/g,'c.uid').replace(/\$2\b/g,'c.started_at').replace(/\$3\b/g,'c.internal_at').replace(/\$4\b/g,'c.internal_flag');
  legacySql=legacySql.replace(/\$1\b/g,'c.uid').replace(/\$2\b/g,"'fixture'").replace(/\$3\b/g,"'wheel'").replace(/\$4\b/g,"'inviter'");
  const fixtures=`WITH cases(uid,member_age,follow_age,flag,prior_type,internal_flag,expected,legacy_expected) AS (VALUES
    ('new',3,4,'false',NULL,NULL,FALSE,NULL::boolean),
    ('old',60,4,'false',NULL,NULL,NULL,TRUE),
    ('unblock',3,4,'true',NULL,NULL,TRUE,TRUE),
    ('prior_follow',3,4,'false','follow',NULL,TRUE,TRUE),
    ('prior_unfollow',3,4,'false','unfollow',NULL,TRUE,TRUE),
    ('missing_log',3,NULL,NULL,NULL,NULL,NULL,TRUE),
    ('missing_flag',3,4,NULL,NULL,NULL,NULL,TRUE),
    ('internal_new',3,NULL,NULL,NULL,'false',FALSE,TRUE),
    ('internal_unblock',3,NULL,NULL,NULL,'true',TRUE,TRUE),
    ('no_member',NULL,4,'false',NULL,NULL,FALSE,FALSE),
    ('future_event',3,-10,'false',NULL,NULL,NULL,TRUE),
    ('legacy_snapshot',3,4,'false',NULL,NULL,FALSE,TRUE),
    ('not_follower_first',3,4,'false',NULL,NULL,FALSE,FALSE)
  ), c AS (
    SELECT *,now()-INTERVAL '10 minutes' AS started_at,
      CASE WHEN internal_flag IS NOT NULL THEN now()-INTERVAL '4 minutes' END AS internal_at
    FROM cases
  ), sample_users AS (
    SELECT uid AS line_user_id,now()-(member_age::text||' minutes')::interval AS created_at,
      NULL::timestamptz AS archived_at FROM cases WHERE member_age IS NOT NULL
  ), sample_events AS (
    SELECT uid AS line_user_id,'follow' AS event_type,
      now()-(follow_age::text||' minutes')::interval AS event_timestamp,
      jsonb_build_object('follow',jsonb_build_object('isUnblocked',flag::boolean)) AS raw_event
    FROM cases WHERE follow_age IS NOT NULL
    UNION ALL SELECT uid,prior_type,now()-INTERVAL '30 minutes','{}'::jsonb
      FROM cases WHERE prior_type IS NOT NULL
  ), sample_activities AS (SELECT 1 AS id,'fixture'::text AS slug,'wheel'::text AS game_type),
  sample_referrals AS (SELECT 1 AS activity_id,'legacy_snapshot'::text AS invitee_line_user_id),
  sample_attempts AS (
    SELECT uid AS invitee_line_user_id,'fixture'::text AS activity_slug,'wheel'::text AS game_type,
      'inviter'::text AS inviter_line_user_id,
      CASE WHEN uid='not_follower_first' THEN 'invitee_not_follower' ELSE 'invitee_status_unavailable' END AS outcome,
      now()-(CASE WHEN uid='not_follower_first' THEN INTERVAL '8 minutes' ELSE INTERVAL '2 minutes' END) AS created_at
    FROM cases
  )`;
  const substitute = sql => sql.replace(/\busers\b/g,'sample_users').replace(/\bline_webhook_events\b/g,'sample_events')
    .replace(/\bactivities\b/g,'sample_activities').replace(/\bactivity_referrals\b/g,'sample_referrals').replace(/\bactivity_referral_attempts\b/g,'sample_attempts');
  return fixtures+` SELECT uid,j.was_existing AS journey_result,l.was_existing AS legacy_result,
    j.was_existing IS NOT DISTINCT FROM expected AS journey_pass,
    l.was_existing IS NOT DISTINCT FROM legacy_expected AS legacy_pass
    FROM c CROSS JOIN LATERAL (${substitute(journeySql)}) j
    CROSS JOIN LATERAL (${substitute(legacySql)}) l ORDER BY uid`;
}
if (require.main===module) buildSql().then(sql=>process.stdout.write(JSON.stringify(sql)));
module.exports={buildSql};
