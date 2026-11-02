'use strict';
// New local-only synthetic database; never reads DATABASE_URL or calls HK/LINE.
if (process.env.CRM_QA_ISOLATED !== '1') throw Error('Requires isolated local QA');
const { Pool } = require('pg'), fs = require('node:fs'), os = require('node:os');
const assert = require('node:assert/strict');
const { createReceiver, signature } = require('../../src/core/lineWebhookInbox');
const { createStagingSender } = require('../../src/core/orMissionFollow');
const config = { host: '/tmp', port: 5432, database: 'postgres', user: os.userInfo().username, max: 5 };
const name = 'or_mission_qa_' + Date.now(), reader = name + '_reader';
const migration = fs.readFileSync('supabase/migrations/20261102075511_or_mission_follow_notifications.sql', 'utf8');
const rollback = fs.readFileSync('supabase/rollbacks/20261102075511_or_mission_follow_notifications.sql', 'utf8');
const secret = 'synthetic-local-secret', uid = 'U' + 'b'.repeat(32);
const env = { APP_ENV: 'staging', SAFE_PREVIEW_MODE: '1', OR_MISSION_FOLLOW_CAPTURE_ENABLED: '1', OR_MISSION_STAGING_SEND_ENABLED: '1' };
function req(id, unblocked = false) {
  const body = JSON.stringify({ destination: 'synthetic-oa', events: [{ type: 'follow', webhookEventId: id,
    timestamp: 1700000000000, source: { type: 'user', userId: uid }, follow: { isUnblocked: unblocked } }] });
  return { httpMethod: 'POST', body, headers: { 'x-line-signature': signature(Buffer.from(body), secret) } };
}
(async () => {
  const admin = new Pool(config); let pool, roleCreated = false, dbCreated = false;
  try {
    await admin.query('CREATE DATABASE ' + name); dbCreated = true;
    pool = new Pool({ ...config, database: name, options: '-c search_path=crm_staging,public' });
    await pool.query('CREATE SCHEMA crm_staging; CREATE TABLE public.qa_guard(id int); INSERT INTO public.qa_guard VALUES(1); CREATE TABLE crm_staging.line_webhook_inbox(event_id text PRIMARY KEY,payload jsonb NOT NULL)');
    await pool.query(migration); await pool.query(migration);
    const checkPublic = await pool.connect();
    try {
      await checkPublic.query('SET search_path=public');
      await assert.rejects(checkPublic.query(migration), /requires crm_staging/);
      assert.equal((await checkPublic.query("SELECT to_regclass('public.or_mission_follow_notifications') AS t")).rows[0].t, null);
    } finally { checkPublic.release(true); }
    console.log('PASS real PG migration/reapply; public schema rejected and unchanged');

    const receive = createReceiver({ channelSecret: secret, missionCaptureEnabled: true, query: pool.query.bind(pool) });
    const batch = await Promise.all(Array.from({ length: 5 }, () => receive(req('synthetic-concurrent'))));
    assert.ok(batch.every(x => x.statusCode === 200));
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM line_webhook_inbox')).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM or_mission_follow_notifications')).rows[0].count), 1);
    await receive(req('synthetic-unblock', true));
    assert.equal((await pool.query("SELECT is_unblocked FROM or_mission_follow_notifications WHERE webhook_event_id='synthetic-unblock'")).rows[0].is_unblocked, true);
    console.log('PASS real PG concurrent redelivery=one inbox/notification; unblock retained without reward');

    await pool.query('ALTER TABLE or_mission_follow_notifications RENAME TO qa_notifications_hidden');
    assert.equal((await receive(req('synthetic-atomic-rollback'))).statusCode, 503);
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM line_webhook_inbox WHERE event_id='synthetic-atomic-rollback'")).rows[0].count), 0);
    await pool.query('ALTER TABLE qa_notifications_hidden RENAME TO or_mission_follow_notifications');
    console.log('PASS real PG outbox failure rolls back inbox insertion atomically');

    let calls = 0;
    const row = (await pool.query("SELECT id FROM or_mission_follow_notifications WHERE webhook_event_id='synthetic-concurrent'")).rows[0];
    const send = createStagingSender({ query: pool.query.bind(pool), env,
      fetchFn: async () => { calls++; return { status: 202 }; } });
    await Promise.all(Array.from({ length: 5 }, () => send(row.id)));
    assert.equal(calls, 1);
    assert.equal((await pool.query('SELECT status FROM or_mission_follow_notifications WHERE id=$1', [row.id])).rows[0].status, 'http_accepted_unverified');
    const unblock = (await pool.query("SELECT id FROM or_mission_follow_notifications WHERE webhook_event_id='synthetic-unblock'")).rows[0];
    let network = 0;
    const ambiguous = createStagingSender({ query: async (sql, params) => {
      if (/SET status=\$2/.test(sql)) throw Error('synthetic-update-failure');
      return pool.query(sql, params);
    }, env, fetchFn: async () => { network++; return { status: 200 }; } });
    assert.equal((await ambiguous(unblock.id)).status, 'uncertain');
    assert.equal((await ambiguous(unblock.id)).status, 'not_claimed'); assert.equal(network, 1);
    console.log('PASS real PG concurrent send=one request; DB loss remains sending and cannot resend');

    await admin.query('CREATE ROLE ' + reader + ' NOLOGIN'); roleCreated = true;
    await pool.query('GRANT USAGE ON SCHEMA crm_staging TO ' + reader);
    const t = 'crm_staging.or_mission_follow_notifications';
    assert.equal((await pool.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed', [reader, t])).rows[0].allowed, false);
    // Even an accidental grant must not expose rows through RLS.
    await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + t + ' TO ' + reader);
    const restricted = await pool.connect();
    try {
      await restricted.query('SET ROLE ' + reader);
      assert.equal((await restricted.query('SELECT * FROM ' + t)).rows.length, 0);
      assert.equal((await restricted.query("UPDATE " + t + " SET status='uncertain' RETURNING id")).rows.length, 0);
      assert.equal((await restricted.query('DELETE FROM ' + t + ' RETURNING id')).rows.length, 0);
      await assert.rejects(restricted.query("INSERT INTO " + t + "(id,webhook_event_id,line_user_id,occurred_at) VALUES(999,'synthetic-rls',$1,now())", [uid]), /row-level security/);
    } finally { restricted.release(true); }
    console.log('PASS real PG no default reader grant; RLS denies select/insert/update/delete');

    await assert.rejects(pool.query(rollback), /Keep notification history/);
    await pool.query('DELETE FROM or_mission_follow_notifications');
    await pool.query(rollback); await pool.query(rollback);
    assert.equal((await pool.query('SELECT COUNT(*) FROM public.qa_guard')).rows[0].count, '1');
    console.log('PASS real PG rollback preserves nonempty history; empty rollback/reapply safe; guard unchanged');
  } finally {
    if (pool) await pool.end();
    if (dbCreated) await admin.query('DROP DATABASE ' + name);
    if (roleCreated) await admin.query('DROP ROLE ' + reader);
    await admin.end();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
