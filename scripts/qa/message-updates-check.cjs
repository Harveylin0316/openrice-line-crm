// Isolated localhost only. Does not load dotenv or production DATABASE_URL.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {Pool}=require('pg');
const {createMessageExecutionStore}=require('../../src/core/messageExecutions');
const {createWelcomeService}=require('../../src/core/welcomeMessages');
const {createMessagePerformance}=require('../../src/core/messagePerformance');
const {loadExcludedTestRecipients}=require('../../src/core/broadcastAudienceExclusions');
const root=path.resolve(__dirname,'../..');
async function main(){
 if(process.env.CRM_QA_ISOLATED!=='1')throw new Error('Set CRM_QA_ISOLATED=1 for the disposable localhost cluster only');
 const connection={host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only'};
 const admin=new Pool({...connection,database:'postgres'});
 const database='crm_message_qa_'+Date.now();
 await admin.query('CREATE DATABASE '+database);
 const pool=new Pool({...connection,database,options:'-c search_path=crm_staging'});
 const query=(s,p)=>pool.query(s,p);const sql=p=>fs.readFileSync(path.join(root,p),'utf8');
 try{
  // This script refuses an already populated schema; never drop someone else's work.
  const exists=await query("SELECT to_regnamespace('crm_staging') AS schema");assert.equal(exists.rows[0].schema,null,'Use a fresh disposable cluster');
  await query('CREATE SCHEMA crm_staging');
  await query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='crm_staging_app') THEN CREATE ROLE crm_staging_app NOLOGIN NOBYPASSRLS NOSUPERUSER; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$; GRANT USAGE ON SCHEMA crm_staging TO crm_staging_app");
  await query(sql('supabase/migrations/20261005090000_message_executions_welcome.sql'));
  await query(sql('supabase/migrations/20261005090000_message_executions_welcome.sql'));
  await query(sql('supabase/rollbacks/20261005090000_message_executions_welcome_rollback.sql'));
  await query(sql('supabase/migrations/20261005090000_message_executions_welcome.sql'));
  console.log('PASS migration, idempotent apply, empty rollback/reapply');
  await query(`CREATE TABLE admin_message_templates(id bigint PRIMARY KEY,name text,message_config jsonb,channel text);
   CREATE TABLE admin_flows(id bigserial PRIMARY KEY,name text,status text,trigger_type text,trigger_config jsonb,re_enroll boolean,created_by text,updated_at timestamptz);
   CREATE TABLE admin_flow_nodes(flow_id bigint,node_key text,type text,config jsonb,next_key text,is_entry boolean,position int);
   CREATE TABLE admin_flow_enrollments(id bigserial PRIMARY KEY,flow_id bigint,user_id int,line_user_id text,status text,current_node_key text,next_run_at timestamptz,context jsonb);
   CREATE UNIQUE INDEX flow_active ON admin_flow_enrollments(flow_id,line_user_id) WHERE status='active';
   CREATE TABLE admin_broadcasts(id bigint PRIMARY KEY,channel text,is_ab_test boolean,audience_config jsonb,created_at timestamptz DEFAULT now());
   CREATE TABLE admin_broadcast_recipients(id bigserial PRIMARY KEY,broadcast_id bigint,line_user_id text,status text,variant text);
   CREATE TABLE admin_broadcast_clicks(id bigserial PRIMARY KEY,broadcast_id bigint,recipient_id bigint,clicked_at timestamptz DEFAULT now());`);
  const rls=await query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('crm_message_executions','crm_message_clicks','crm_welcome_settings')");assert.ok(rls.rows.every(r=>r.relrowsecurity));
  const permissions=await query("SELECT has_table_privilege('anon','crm_message_executions','SELECT') AS anon,has_table_privilege('authenticated','crm_message_executions','INSERT') AS auth,has_table_privilege('crm_staging_app','crm_message_executions','INSERT') AS staging");assert.deepEqual(permissions.rows[0],{anon:false,auth:false,staging:true});
  const roleClient=await pool.connect();try{await roleClient.query('SET ROLE crm_staging_app');assert.equal((await roleClient.query('SELECT enabled FROM crm_welcome_settings')).rows[0].enabled,false);}finally{await roleClient.query('RESET ROLE');roleClient.release();}
  console.log('PASS RLS enabled, anonymous/authenticated denied, staging role permitted');
  const store=createMessageExecutionStore({query}),welcome=createWelcomeService({pool,query,executionStore:store});
  const cfg={mode:'sequence',items:[{type:'text',text:'STAGING welcome https://example.com/?variant=a'}]};
  await query('INSERT INTO admin_message_templates VALUES(1,$1,$2::jsonb,$3)',['STAGING welcome',JSON.stringify(cfg),'line']);
  const saved=await welcome.save({revision:1,enabled:true,duplicateCheckConfirmed:true,messageId:1,firstEnabled:true,unblockedEnabled:true},'STAGING reviewer');
  assert.equal(saved.revision,'2');
  const evidence={webhookEventId:'STAGING-event-1',isUnblocked:false,hadPriorFriendEvidence:false};
  const claimed=await Promise.all([welcome.claimFollow('STAGING-person-1',evidence),welcome.claimFollow('STAGING-person-1',evidence)]);assert.equal(claimed.filter(r=>r.enrolled).length,1);
  assert.equal(Number((await query('SELECT COUNT(*) n FROM crm_message_executions')).rows[0].n),1);
  await query('UPDATE admin_message_templates SET message_config=$1::jsonb WHERE id=1',[JSON.stringify({...cfg,items:[{type:'text',text:'STAGING changed'}]})]);
  const e=(await query('SELECT * FROM crm_message_executions')).rows[0];assert.equal(e.message_snapshot.items[0].text,cfg.items[0].text);
  await assert.rejects(welcome.save({revision:1,enabled:false}),/revision_conflict/);
  await welcome.claimFollow('STAGING-person-2',{webhookEventId:'STAGING-event-2'});assert.equal((await query("SELECT reason FROM crm_message_executions WHERE recipient_key='STAGING-person-2'")).rows[0].reason,'follow_identity_unknown');
  await welcome.claimFollow('STAGING-person-3',{webhookEventId:'STAGING-event-3',isUnblocked:true});
  assert.equal(Number((await query('SELECT COUNT(*) n FROM admin_flow_enrollments')).rows[0].n),2);
  // Redelivery wins the race and initially has unknown member evidence.
  await welcome.claimFollow('STAGING-race',{webhookEventId:'STAGING-race-event',isUnblocked:false});
  const rescued=await welcome.claimFollow('STAGING-race',{webhookEventId:'STAGING-race-event',isUnblocked:false,hadPriorFriendEvidence:false});
  assert.equal(rescued.enrolled,true);
  assert.equal((await welcome.claimFollow('STAGING-race',{webhookEventId:'STAGING-race-event',isUnblocked:false,hadPriorFriendEvidence:false})).skipped,'duplicate');
  console.log('PASS earlier unknown redelivery is upgraded by original first-follow evidence exactly once');
  const began=await Promise.all([store.begin(e.id),store.begin(e.id)]);assert.equal(began.filter(Boolean).length,1);await store.finish(e.id,{status:'accepted'});assert.equal(await store.finish(e.id,{status:'rejected'}),null);
  console.log('PASS concurrent welcome claim/begin, first/unblocked/unknown, immutable snapshot, revision conflict');
  await query('UPDATE crm_message_executions SET targets=$2::jsonb WHERE id=$1',[e.id,JSON.stringify([{index:0,slotIndex:0,tracked:true,uri:'https://example.com/?variant=a'}])]);
  await query('INSERT INTO crm_message_clicks(execution_id,action_index,verified_identity,event_key) VALUES($1,0,$2,$3)',[e.id,'STAGING-person-1','STAGING-click-1']);
  const report=createMessagePerformance({query});const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const metrics=await report.summary({source:'welcome',from:day,to:day});assert.equal(metrics.rows[0].accepted,1);assert.equal(metrics.rows[0].denominator,1);assert.equal(metrics.rows[0].uniqueClickers,1);assert.equal(metrics.rows[0].rate,1);await report.summary({source:'welcome',revision:2,from:day,to:day});
  const detail=await report.details(e.id);assert.equal(detail.actions[0].clicks,1);
  await report.summary({source:'broadcast',from:day,to:day});await report.executions({from:day,to:day});
  console.log('PASS performance SQL, Taipei dates, detailed action counts');
  await query("INSERT INTO admin_broadcasts(id,channel,is_ab_test,audience_config) VALUES(1,'line',true,'{}')");
  await query("INSERT INTO admin_broadcast_recipients(broadcast_id,line_user_id,status,variant) SELECT 1,'STAGING-pool-'||n,CASE WHEN n%2=0 THEN 'failed' ELSE 'sent' END,CASE WHEN n<=385 THEN 'a' ELSE 'b' END FROM generate_series(1,770) n");
  const excluded=await loadExcludedTestRecipients(query,[1]);const poolNow=Array.from({length:1400},(_,i)=>'staging-pool-'+(i+1));assert.equal(poolNow.filter(id=>!excluded.has(id)).length,630);
  console.log('PASS dynamic pool 1283 → 1400, exclude all 770 test recipients (including failed), 630 remain');
  await query(`CREATE TABLE line_push_logs(id serial PRIMARY KEY,user_id int,line_user_id text,push_type text,status text,http_status int,detail text,payload jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE users(id serial PRIMARY KEY,line_user_id text,line_display_name text,username text,blocked_at timestamptz,archived_at timestamptz);`);
  await query("INSERT INTO line_push_logs(line_user_id,push_type,status,payload) VALUES('STAGING-person-1','welcome','success',$1::jsonb)",[JSON.stringify({executionId:e.id})]);
  const {unifiedLogsCte,detailSql}=require('../../src/routes/adminPushLogs');
  const union=await query('WITH '+unifiedLogsCte()+' SELECT * FROM unified_logs ORDER BY id');
  assert.equal(union.rows.filter(r=>r.line_user_id==='STAGING-person-1').length,1);
  assert.ok(union.rows.some(r=>r.status==='skipped'));
  const detailsSql=detailSql('TRUE','$1').replace(/FROM line_push_logs l/g,'FROM unified_logs l');
  const detailed=await query('WITH '+unifiedLogsCte()+', '+detailsSql.slice(5),[51]);assert.ok(detailed.rows.length>0);
  console.log('PASS unified logs SQL, execution/push deduplication, skipped events, detail joins');
  await query(`CREATE SEQUENCE qa_broadcast_id START 100;
    ALTER TABLE admin_broadcasts ALTER COLUMN id SET DEFAULT nextval('qa_broadcast_id');
    ALTER TABLE admin_broadcasts ADD COLUMN status text, ADD COLUMN started_at timestamptz, ADD COLUMN updated_at timestamptz, ADD COLUMN admin_username text, ADD COLUMN message_config jsonb, ADD COLUMN variant_b_message_config jsonb, ADD COLUMN recipient_total int;
    ALTER TABLE admin_broadcast_recipients ADD COLUMN user_id int,ADD COLUMN email text;`);
  const experiment={enabled:true,variantCount:2,winnerMode:'manual',winnerAt:'2020-01-01T00:00:00Z'};
  await query("UPDATE admin_broadcasts SET status='awaiting_winner',audience_config=$1::jsonb,message_config=$2::jsonb,variant_b_message_config=$3::jsonb WHERE id=1",[JSON.stringify({experiment}),JSON.stringify(cfg),JSON.stringify({mode:'sequence',items:[{type:'text',text:'STAGING B'}]})]);
  await query("INSERT INTO admin_broadcast_recipients(broadcast_id,line_user_id,status,variant) VALUES(1,'STAGING-holdout','waiting_winner','holdout')");
  const routes={};require('../../src/routes/adminBroadcast').registerAdminBroadcastRoutes({get(){},post(p,...h){routes[p]=h.at(-1)},put(){},delete(){}},{query,pool,authCore:{requireAdmin(){}},linePush:{},emailProvider:{isConfigured:()=>false},lineChannelAccessToken:'STAGING-mock-not-a-token'});
  const release=routes[Object.keys(routes).find(k=>k.endsWith('/release-experiment-winner'))];
  async function runRelease(){const response={status(n){this.code=n;return this},json(b){this.body=b;return this}};await release({params:{id:1},body:{winner_variant:'b'},authUser:{un:'STAGING QA'}},response);assert.equal(response.body.ok,true,JSON.stringify(response.body));return response.body;}
  const released=await Promise.all([runRelease(),runRelease()]);assert.equal(released.filter(r=>r.alreadyReleased).length,1);assert.equal(released[0].broadcastId,released[1].broadcastId);
  const winner=(await query('SELECT message_config FROM admin_broadcasts WHERE id=$1',[released[0].broadcastId])).rows[0];assert.equal(winner.message_config.items[0].text,'STAGING B');
  console.log('PASS two concurrent winner releases create exactly one B snapshot batch');
  await assert.rejects(query(sql('supabase/rollbacks/20261005090000_message_executions_welcome_rollback.sql')));
  console.log('PASS rollback refuses retained execution/click data');
 }finally{await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
