// Local PostgreSQL only. Creates a uniquely named disposable private schema;
// never loads environment files, secrets, or a remote database URL.
const { Pool } = require('pg');
const assert = require('node:assert/strict');
const { loadDecisions, repairReferral } = require('../../src/core/referralDecisions');
const schema = 'crm_referral_qa_' + process.pid;
const admin = new Pool({ host: '/tmp', database: 'postgres', user: process.env.USER });
const pool = new Pool({ host: '/tmp', database: 'postgres', user: process.env.USER,
  options: '-c search_path=' + schema, max: 5 });
const inviter = 'U'+'a'.repeat(32), invitee = 'U'+'b'.repeat(32);
async function run() {
  await admin.query('CREATE SCHEMA ' + schema);
  try {
    await pool.query(`CREATE TABLE activities(id bigint PRIMARY KEY,slug text,game_type text,status text,
      start_at timestamptz,end_at timestamptz,referral_bonus_per int,referral_bonus_max int,referral_invites_per_bonus int);
      CREATE TABLE users(id bigserial PRIMARY KEY,line_user_id text UNIQUE,line_display_name text,
        created_at timestamptz DEFAULT now(),archived_at timestamptz,blocked_at timestamptz);
      CREATE TABLE activity_referrals(id bigserial PRIMARY KEY,activity_id bigint,inviter_line_user_id text,
        invitee_line_user_id text,invitee_was_existing boolean,created_at timestamptz DEFAULT now(),
        UNIQUE(activity_id,invitee_line_user_id));
      CREATE TABLE activity_referral_attempts(id bigserial PRIMARY KEY,activity_slug text,game_type text,
        inviter_line_user_id text,invitee_line_user_id text,outcome text,created_at timestamptz DEFAULT now());
      CREATE TABLE line_webhook_events(line_user_id text,event_type text,event_timestamp timestamptz,raw_event jsonb);
      CREATE TABLE activity_bonus_plays(activity_id bigint,line_user_id text,plays int);
      CREATE TABLE activity_user_quotas(activity_id bigint,line_user_id text,max_plays_override int);
      CREATE TABLE admin_test_recipients(line_user_id text);`);
    await pool.query(`INSERT INTO activities VALUES(6,'fixture','wheel','active',now()-interval '1 day',
      now()+interval '1 day',1,3,1)`);
    await pool.query(`INSERT INTO users(line_user_id,line_display_name,created_at)
      VALUES($1,'Inviter',now()-interval '1 day'),($2,'Invitee',now()-interval '3 minutes')`,[inviter,invitee]);
    await pool.query(`INSERT INTO activity_referral_attempts(activity_slug,game_type,inviter_line_user_id,
      invitee_line_user_id,outcome,created_at) VALUES('fixture','wheel',$1,$2,'invitee_not_follower',now()-interval '4 minutes')`,[inviter,invitee]);
    await pool.query(`INSERT INTO line_webhook_events VALUES($1,'follow',now()-interval '3 minutes',
      '{"follow":{"isUnblocked":false}}')`,[invitee]);
    const activity=(await pool.query('SELECT * FROM activities')).rows[0];
    assert.equal((await loadDecisions(pool.query.bind(pool),activity)).counts.needs_repair,1);
    const simultaneous=await Promise.allSettled(Array.from({length:5},()=>repairReferral(pool,6,inviter,invitee,'fixture-admin')));
    assert.equal(simultaneous.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM activity_referrals')).rows[0].count),1);
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM activity_referral_attempts WHERE outcome LIKE 'admin_reconciled:%'")).rows[0].count),1);
    assert.equal((await loadDecisions(pool.query.bind(pool),activity)).counts.no_action,1);
    // Restore a synthetic historical false classification; evidence qualifies,
    // but no separate manual bonus is inserted and historical timestamp stays.
    await pool.query('UPDATE activity_referrals SET invitee_was_existing=TRUE');
    assert.equal((await loadDecisions(pool.query.bind(pool),activity)).counts.needs_repair,1);
    await repairReferral(pool,6,inviter,invitee,'fixture-admin');
    assert.equal((await pool.query('SELECT invitee_was_existing FROM activity_referrals')).rows[0].invitee_was_existing,false);
    await pool.query('UPDATE activity_referrals SET invitee_was_existing=TRUE');
    await pool.query('INSERT INTO activity_bonus_plays VALUES(6,$1,1)',[inviter]);
    await assert.rejects(repairReferral(pool,6,inviter,invitee,'fixture-admin'),/not_repairable/);
    await pool.query('DELETE FROM activity_bonus_plays');
    await pool.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.outcome LIKE 'admin_reconciled:%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER audit_failure BEFORE INSERT ON activity_referral_attempts FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
    await assert.rejects(repairReferral(pool,6,inviter,invitee,'fixture-admin'),/fixture audit failure/);
    assert.equal((await pool.query('SELECT invitee_was_existing FROM activity_referrals')).rows[0].invitee_was_existing,true);
    await pool.query('DROP TRIGGER audit_failure ON activity_referral_attempts');
    await pool.query('DELETE FROM activity_referral_attempts');
    assert.equal((await loadDecisions(pool.query.bind(pool),activity)).counts.insufficient,1);
    console.log('Local PostgreSQL: evidence classification, 5 concurrent repairs, idempotency, historical correction, manual-bonus guard, audit rollback, insufficient-evidence guard PASS');
  } finally {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
}
run().catch(err=>{console.error(err.message);process.exitCode=1;});
