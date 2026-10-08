// Real PostgreSQL regression, restricted to the disposable localhost QA cluster.
// No dotenv, external sends, or production connection strings.
'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createMessagePerformanceList } = require('../../src/core/messagePerformanceList');
if (process.env.CRM_QA_ISOLATED !== '1') throw Error('Requires CRM_QA_ISOLATED=1');
const conn = {host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only'};
async function main() {
 const admin = new Pool({...conn,database:'postgres'});
 const database = 'crm_report_qa_' + Date.now();
 await admin.query('CREATE DATABASE '+database);
 const pool = new Pool({...conn,database});
 const query = (s,p)=>pool.query(s,p);
 const failures=[];
 async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e.message);}}
 try {
 await query(`CREATE TABLE admin_broadcasts(id bigint PRIMARY KEY,created_at timestamptz,status text,channel text,is_ab_test boolean,message_config jsonb,variant_b_message_config jsonb,audience_config jsonb);
 CREATE TABLE admin_broadcast_recipients(id bigint PRIMARY KEY,broadcast_id bigint,line_user_id text,status text,variant text,pushed_at timestamptz);
 CREATE TABLE admin_broadcast_clicks(broadcast_id bigint,recipient_id bigint,variant text,button_index int);
 CREATE TABLE crm_message_executions(id bigint PRIMARY KEY,source_type text,source_id bigint,revision bigint,created_at timestamptz,started_at timestamptz,status text,recipient_key text,targets jsonb,message_snapshot jsonb,test_only boolean DEFAULT false);
 CREATE TABLE crm_message_clicks(execution_id bigint,action_index int,verified_identity text);
 CREATE TABLE admin_keyword_replies(id int,keywords text);
 CREATE TABLE keyword_reply_experiments(id bigint,rule_id int,name text,state text,start_at timestamptz,end_at timestamptz,attribution_days int,variant_a_config jsonb,variant_b_config jsonb,variant_a_name text,variant_b_name text,targets jsonb);
 CREATE TABLE keyword_reply_experiment_assignments(experiment_id bigint,variant text,line_user_id text,first_success_at timestamptz);
 CREATE TABLE keyword_reply_experiment_deliveries(experiment_id bigint,variant text,line_user_id text,status text);
 CREATE TABLE keyword_reply_experiment_clicks(experiment_id bigint,variant text,line_user_id text,target_index int,clicked_at timestamptz);`);
 const cfg = {mode:'flex_json',flex:{type:'flex',altText:'STAGING QA',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'STAGING link',uri:'https://example.com/?variant=a'}}]}}}};
 await query(`INSERT INTO admin_broadcasts VALUES(1,'2026-10-07T04:00Z','done','line',true,$1,$1,'{}')`,[cfg]);
 await query(`INSERT INTO admin_broadcast_recipients VALUES
 (1,1,'STAGING-a','sent','a','2026-10-08T01:00Z'),
 (2,1,'STAGING-b','sent','b','2026-10-09T01:00Z'),
 (3,1,'STAGING-failed','failed','a','2026-10-08T02:00Z');
 INSERT INTO admin_broadcast_clicks VALUES(1,1,'a',0),(1,1,'a',0),(1,2,'b',0),(1,3,'a',0);`);
 await query(`INSERT INTO crm_message_executions VALUES
 (1,'welcome',1,101,'2026-10-07T04:00Z','2026-10-08T01:00Z','accepted','STAGING-a',$1,$2,false),
 (2,'welcome',1,101,'2026-10-07T04:00Z','2026-10-09T01:00Z','accepted','STAGING-b',$1,$2,false),
 (3,'welcome',1,101,'2026-10-07T04:00Z','2026-10-08T01:00Z','rejected','STAGING-fail',$1,$2,false),
 (4,'welcome',1,101,'2026-10-08T01:00Z',NULL,'pending','STAGING-pending',$1,$2,false);
 `,[JSON.stringify([{index:0,tracked:true,uri:'https://example.com/welcome'}]),cfg]);
 await query(`INSERT INTO crm_message_clicks VALUES(1,0,'STAGING-a'),(1,0,'STAGING-a'),(2,0,'STAGING-b'),(3,0,'STAGING-fail'),(1,0,'STAGING-wrong');`);
 const targets={a:[{index:0,label:'STAGING primary',uri:'https://example.com/a'},{index:1,label:'STAGING secondary',uri:'https://example.com/other'}],b:[{index:0,label:'STAGING B',uri:'https://example.com/b'}],primary:{a:[0],b:[0]}};
 await query(`INSERT INTO keyword_reply_experiments VALUES(1,1,'STAGING AB','completed','2026-10-01','2026-10-10',1,$1,$1,'A','B',$2)`,[cfg,targets]);
 await query(`INSERT INTO keyword_reply_experiment_assignments VALUES(1,'a','STAGING-a','2026-10-08T01:00Z'),(1,'b','STAGING-b','2026-10-08T01:00Z');
 INSERT INTO keyword_reply_experiment_deliveries VALUES(1,'a','STAGING-a','accepted'),(1,'b','STAGING-b','accepted');
 INSERT INTO keyword_reply_experiment_clicks VALUES
 (1,'a','STAGING-a',0,'2026-10-08T01:00Z'),(1,'a','STAGING-a',0,'2026-10-08T02:00Z'),
 (1,'a','STAGING-a',0,'2026-10-07T23:00Z'),(1,'a','STAGING-a',0,'2026-10-09T01:00Z'),
 (1,'a','STAGING-a',1,'2026-10-08T03:00Z'),(1,'a','STAGING-b',0,'2026-10-08T03:00Z'),
 (1,'a','STAGING-unassigned',0,'2026-10-08T03:00Z');`);
 const service = createMessagePerformanceList({query});
 const day={from:'2026-10-08',to:'2026-10-08'};
 await check('broadcast scheduled across days uses recipient send time, not creation',async()=>{
  assert.equal((await service.list({...day,source:'broadcast'})).rows[0]?.people,1);
  assert.equal((await service.list({source:'broadcast',from:'2026-10-07',to:'2026-10-07'})).rows.length,0);
  const row=(await service.list({...day,source:'broadcast'})).rows[0];
  assert.equal(row.clicks,2);assert.equal(row.clickers,1);assert.equal(row.failures.rejected,1);
  assert.equal(new Date(row.firstAt).toISOString(),'2026-10-08T01:00:00.000Z');
 });
 await check('broadcast detail uses same sent-recipient cohort and excludes failed recipient clicks',async()=>{
  const groups=(await service.detail({...day,type:'broadcast',sourceId:1})).groups;
  assert.equal(groups[0].links[0].clicks,2);assert.equal(groups[0].links[0].people,1);assert.equal(groups[1].links[0].clicks,0);
 });
 await check('delayed executions use send start time; pending is not sent',async()=>{
  const row=(await service.list({...day,source:'welcome'})).rows[0];
  assert.equal(row?.people,1);assert.equal(row.clicks,2);assert.equal(row.failures.rejected,1);assert.equal(row.failures.pending,0);
 });
 await check('execution detail excludes other days, unaccepted and unverified clicks',async()=>{
  const d=await service.detail({...day,type:'welcome',sourceId:1,revision:'101'});
  assert.equal(d.groups[0].links[0].clicks,2);assert.equal(d.groups[0].links[0].people,1);
 });
 await check('keyword AB details obey assignment variant and [first success, window end)',async()=>{
  const d=await service.detail({type:'keyword_ab',experimentId:1});
  assert.equal(d.groups[0].links[0].clicks,2);assert.equal(d.groups[0].links[0].people,1);
  assert.equal(d.groups[0].links[0].primary,true);assert.equal(d.groups[0].links[1].primary,false);
 });
 await check('keyword AB list counts only primary clicks inside attribution window',async()=>{
  const row=(await service.list({...day,source:'keyword'})).rows[0];
  assert.equal(row.clicks,2);assert.equal(row.clickers,1);assert.equal(row.people,2);assert.equal(row.rate,50);
 });
 await query(`CREATE TABLE users(line_user_id text,is_admin boolean,created_at timestamptz,blocked_at timestamptz,archived_at timestamptz);
 CREATE TABLE line_webhook_events(created_at timestamptz,event_type text);
 CREATE TABLE rich_menu_taps(menu_id int,tab int,cell int,kind text,label text,line_user_id text,created_at timestamptz);
 CREATE TABLE rich_menus(id int,name text);
 CREATE TABLE activity_plays(activity_id int,played_at timestamptz,prize_snapshot jsonb,line_user_id text);
 CREATE TABLE activities(id int,name text);
 CREATE TABLE activity_referrals(created_at timestamptz,invitee_was_existing boolean);
 CREATE TABLE line_follow_sources(source_key text,updated_at timestamptz);
 INSERT INTO rich_menus VALUES(1,'STAGING 圖文選單');
 INSERT INTO rich_menu_taps VALUES
 (1,0,0,'uri','STAGING 訂位','STAGING-a','2026-10-08T01:00Z'),
 (1,0,0,'uri','STAGING 訂位','STAGING-a','2026-10-08T02:00Z'),
 (1,0,0,'uri','STAGING 訂位',NULL,'2026-10-08T03:00Z'),
 (1,0,1,'uri','STAGING 獎勵','STAGING-a','2026-10-08T03:00Z'),
 (1,0,1,'uri','STAGING 獎勵','STAGING-b','2026-10-08T03:00Z'),
 (1,0,2,'uri','STAGING 匿名',NULL,'2026-10-08T03:00Z'),
 (1,0,0,'uri','STAGING 訂位','STAGING-outside','2026-10-07T15:59Z');`);
 const insightRoutes={};
 const authCore={requireAdmin:(req,res,next)=>next()};
 require('../../src/routes/adminInsight').registerAdminInsightRoutes({get(p,...h){insightRoutes[p]=h.at(-1)}},{query,authCore});
 // Only the LINE statistics dependency is unavailable; all CRM queries hit real PostgreSQL.
 const realFetch=global.fetch;global.fetch=async()=>{throw Error('LOCAL_QA_LINE_DISABLED')};
 await check('rich menu counts repeats, global unique people, anonymous and Taipei boundary',async()=>{
  const res={status(){return this},json(body){this.body=body;return this}};
  await insightRoutes['/admin/insight/api/data']({query:day},res);
  assert.equal(res.body.ok,true);assert.equal(res.body.rich_menu_people,2);assert.equal(res.body.rich_menu_anonymous_taps,2);
  const top=res.body.top_buttons.find(x=>x.cell===0);assert.equal(top.taps,3);assert.equal(top.people,1);assert.equal(top.identified_taps,2);
  assert.equal(res.body.daily[0].menu_taps,6);
 });
 global.fetch=realFetch;
 assert.equal(failures.length,0,failures.join('; '));
 if (process.env.CRM_QA_SERVE === '1') {
  const express=require('express'),path=require('node:path');
  const app=express();app.set('views',path.join(__dirname,'../../views'));app.set('view engine','ejs');
  app.use(express.static(path.join(__dirname,'../../public')));
  app.use((req,res,next)=>{req.authUser={un:'STAGING LOCAL SYNTHETIC QA'};Object.assign(res.locals,{appEnv:'staging',safePreviewMode:true,isSafePreview:true});next();});
  require('../../src/routes/adminMessagePerformance').registerAdminMessagePerformance(app,{query,authCore});
  global.fetch=async()=>{throw Error('LOCAL_QA_LINE_DISABLED')};
  require('../../src/routes/adminInsight').registerAdminInsightRoutes(app,{query,authCore});
  const server=await new Promise(resolve=>{const srv=app.listen(3108,'127.0.0.1',()=>resolve(srv));});
  console.log('LOCAL_SYNTHETIC_REPORT_READY http://127.0.0.1:3108/admin/message-performance?from=2026-10-08&to=2026-10-08');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  await new Promise(resolve=>server.close(resolve));
 }
 } finally {await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
