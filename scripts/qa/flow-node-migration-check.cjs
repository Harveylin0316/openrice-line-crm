// PostgreSQL via PGlite, isolated in memory; no credentials or external sends.
// NODE_PATH=/private/tmp/crm-flow-db-qa/node_modules node scripts/qa/flow-node-migration-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { registerAdminFlowsRoutes } = require('../../src/routes/adminFlows');
const { createFlowEngine } = require('../../src/core/flowEngine');
(async () => {
 const db = new PGlite();
 try {
 await db.exec(`CREATE SCHEMA crm_staging;
 CREATE TABLE public.admin_flow_nodes(type text CHECK(type IN ('send','wait','branch','end','add_to_list')));
 INSERT INTO public.admin_flow_nodes VALUES ('send');
 SET search_path TO crm_staging;
 CREATE TABLE admin_flows(id serial PRIMARY KEY,name text,status text,trigger_type text,trigger_config jsonb,re_enroll boolean,created_by text);
 CREATE TABLE admin_flow_nodes(id serial PRIMARY KEY,flow_id int,node_key text,type text NOT NULL,config jsonb,next_key text,branch_true_key text,branch_false_key text,is_entry boolean,position int,
 CONSTRAINT admin_flow_nodes_type_check CHECK(type IN ('send','wait','branch','end','add_to_list')));
 INSERT INTO admin_flow_nodes(type) VALUES ('send');
 CREATE TABLE user_tags(id bigint PRIMARY KEY,name text);
 INSERT INTO user_tags VALUES (11,'STAGING A'),(12,'STAGING B');
 CREATE TABLE user_tag_members(tag_id bigint,line_user_id text,added_by text,expires_at timestamptz,source_rule_id bigint,PRIMARY KEY(tag_id,line_user_id));
 CREATE TABLE admin_flow_enrollments(id serial PRIMARY KEY,flow_id int,line_user_id text,current_node_key text,context jsonb,status text,last_message_id int,last_message_sent_at timestamptz,updated_at timestamptz);`);
 for (const type of ['ab_split','add_tag','remove_tag']) await assert.rejects(db.query('INSERT INTO admin_flow_nodes(type) VALUES ($1)',[type]),e=>e.code==='23514');
 console.log('PASS legacy constraint reproduces rejection of all three types');
 const before=(await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='public.admin_flow_nodes'::regclass")).rows;
 const migration=fs.readFileSync('scripts/staging/20261113-flow-node-types.sql','utf8');
 const rollback=fs.readFileSync('scripts/staging/20261113-flow-node-types-rollback.sql','utf8');
 await db.exec(migration); await db.exec(migration);
 for(const type of ['send','wait','branch','end','add_to_list','ab_split','add_tag','remove_tag']) await db.query('INSERT INTO admin_flow_nodes(type) VALUES ($1)',[type]);
 await assert.rejects(db.query("INSERT INTO admin_flow_nodes(type) VALUES ('unknown')"),e=>e.code==='23514');
 assert.deepEqual((await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='public.admin_flow_nodes'::regclass")).rows,before);
 await assert.rejects(db.query("INSERT INTO public.admin_flow_nodes(type) VALUES ('ab_split')"),e=>e.code==='23514');
 console.log('PASS idempotent migration, eight allowed types, unknown rejected, public unchanged');
 const query=async(s,p)=>{const r=await db.query(s,p);return {...r,rowCount:r.rows.length || r.affectedRows || 0};};
 const routes={},app={}; for(const m of ['get','post','put','delete'])app[m]=(p,...h)=>routes[m+' '+p]=h.at(-1);
 registerAdminFlowsRoutes(app,{query,pool:{connect:async()=>({query,release(){}})},flowEngine:{},authCore:{requireAdmin:(_q,_r,n)=>n()}});
 const call=async(key,body,id)=>{const r={status(n){this.code=n;return this;},json(b){this.body=b;return this;}};await routes[key]({body,params:{id:String(id)},authUser:{un:'STAGING'}},r);return r.body;};
 const body={name:'STAGING DB QA',trigger:{type:'schedule',config:{freq:'weekly',hour:10,minute:32,start_date:'2050-11-15',audience:{type:'all'}}},steps:[{type:'ab_split',mode:'random',a:[{type:'add_tag',tag_id:11,ttl_days:7},{type:'remove_tag',tag_id:12}],b:[{type:'add_tag',tag_id:12,ttl_days:14},{type:'remove_tag',tag_id:11}]}]};
 const saved=await call('post /admin/flows/api',body);assert.equal(saved.ok,true,JSON.stringify(saved));
 const reopened=await call('get /admin/flows/api/:id',null,saved.id);assert.equal(reopened.ok,true,JSON.stringify(reopened));
 assert.equal(reopened.flow.steps[0].a[0].tag_id,11);assert.equal(reopened.flow.steps[0].b[0].tag_id,12);
 assert.equal(reopened.flow.trigger.config.minute,32);assert.equal(reopened.flow.trigger.config.start_date,'2050-11-15');
 const entry=(await query('SELECT node_key FROM admin_flow_nodes WHERE flow_id=$1 AND is_entry',[saved.id])).rows[0].node_key;
 const engine=createFlowEngine({query,pool:{},linePush:{push(){throw Error('NO SENDS ALLOWED');}}});
 for(const [i,variant] of ['a','b'].entries()){
  const uid='STAGING_DB_QA_'+variant;
  await query('INSERT INTO admin_flow_enrollments(id,flow_id,line_user_id,current_node_key,context,status) VALUES($1,$2,$3,$4,$5,\'active\')',[i+1,saved.id,uid,entry,JSON.stringify({ab_variant:variant})]);
  for(let repeat=0;repeat<2;repeat++) await engine._processEnrollment((await query('SELECT * FROM admin_flow_enrollments WHERE id=$1',[i+1])).rows[0]);
  assert.deepEqual((await query('SELECT tag_id FROM user_tag_members WHERE line_user_id=$1',[uid])).rows.map(r=>Number(r.tag_id)),[variant==='a'?11:12]);
  assert.equal((await query('SELECT status FROM admin_flow_enrollments WHERE id=$1',[i+1])).rows[0].status,'done');
 }
 console.log('PASS actual route save/reopen preserves schedule and tags; engine A/B executes independently on repeat');
 await assert.rejects(db.exec(rollback),/rollback blocked/); await db.exec('ROLLBACK');
 await db.query("INSERT INTO admin_flow_nodes(type) VALUES ('ab_split')");
 // Disposable local fixtures only; never delete cloud flow data to force a rollback.
 await db.exec("DELETE FROM admin_flow_nodes WHERE type IN ('ab_split','add_tag','remove_tag')");
 await db.exec(rollback); await db.exec(rollback);
 await assert.rejects(db.query("INSERT INTO admin_flow_nodes(type) VALUES ('ab_split')"),e=>e.code==='23514');
 assert.ok((await db.query("SELECT * FROM admin_flow_nodes WHERE type='send'")).rows.length);
 console.log('PASS rollback refuses incompatible data atomically; safe rollback repeatable, legacy data retained');
 } finally { await db.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
