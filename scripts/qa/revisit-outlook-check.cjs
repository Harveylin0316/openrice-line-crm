'use strict';
const {Pool}=require('pg');const fs=require('node:fs');const assert=require('node:assert/strict');
const {registerRevisitOutlook}=require('../../src/routes/revisitOutlook');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Requires isolated local QA');
(async()=>{
 const conn={host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres'};
 const admin=new Pool(conn);const name='revisit_outlook_'+Date.now();await admin.query('CREATE DATABASE '+name);const pool=new Pool({...conn,database:name,max:8});
 try{
  await pool.query(`CREATE TABLE revisit_email_settings(id int PRIMARY KEY,daily_send_limit int);
   INSERT INTO revisit_email_settings VALUES(1,200);
   CREATE TABLE revisit_email_campaigns(id int PRIMARY KEY,status text,started_at timestamptz);
   INSERT INTO revisit_email_campaigns VALUES(1,'draft',null);
   CREATE TABLE revisit_email_recipients(id int PRIMARY KEY,campaign_id int,booking_id int,recipient_email text,recipient_name text,
    subject text,body_copy text,cta_url text,unsubscribe_token text,status text,updated_at timestamptz DEFAULT now(),sent_at timestamptz,failure_detail text);
   INSERT INTO revisit_email_recipients VALUES(1,1,1,'qa@example.com','測試客人','測試回訪','純虛構餐廳回訪內容','https://example.com/book',repeat('a',48),'pending',now(),null,null);
   CREATE TABLE admin_email_unsubscribes(email text);
   CREATE TABLE revisit_email_suppressions(email_normalized text,active boolean);
   CREATE TABLE revisit_email_recipient_events(recipient_id int,campaign_id int,event_type text CONSTRAINT revisit_email_recipient_events_event_type_check CHECK(event_type IN('manual_confirm_sent','manual_retry','manual_cancel','auto_hard_bounce')),detail jsonb,acted_by text);`);
  const migration=fs.readFileSync('supabase/migrations/20261012122939_revisit_outlook_draft_audit.sql','utf8');await pool.query(migration);await pool.query(migration);
  await pool.query(fs.readFileSync('supabase/rollbacks/20261012122939_revisit_outlook_draft_audit_rollback.sql','utf8'));await pool.query(migration);
  let handler;
  registerRevisitOutlook({post:(path,...h)=>handler=h.at(-1)}, {pool,requireOwner:()=>{},originFor:()=> 'https://crm.example.com',jsonError:(r,c,e)=>r.status(c).json({error:e}),schemaError:r=>r.status(503).json({error:'db_failed'})});
  async function run(){const r={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};await handler({params:{id:'1'},body:{confirmed:true},authUser:{un:'QA'}},r);assert.equal(r.statusCode,200);return r.body}
  const results=await Promise.all(Array.from({length:5},run));assert.equal(results.filter(x=>!x.reopened).length,1);
  assert.equal((await pool.query('SELECT * FROM revisit_email_recipient_events')).rowCount,1);
  assert.equal((await pool.query('SELECT status FROM revisit_email_recipients')).rows[0].status,'needs_review');
  assert.equal((await pool.query('SELECT sent_at FROM revisit_email_recipients')).rows[0].sent_at,null);
  await assert.rejects(pool.query(fs.readFileSync('supabase/rollbacks/20261012122939_revisit_outlook_draft_audit_rollback.sql','utf8')),/Outlook audit exists/);
  console.log('PASS real PG: migration twice, empty rollback, 5 concurrent requests reserve once; no sent_at; audit-preserving rollback');
  await pool.query("INSERT INTO admin_email_unsubscribes VALUES('qa@example.com')");
  const blocked={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};
  await handler({params:{id:'1'},body:{confirmed:true},authUser:{un:'QA'}},blocked);assert.equal(blocked.statusCode,409);assert.ok(!blocked.body.draft);
  console.log('PASS real PG: unsubscribe after draft reservation blocks reopening');
 }finally{await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
