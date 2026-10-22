// Disposable localhost PostgreSQL, synthetic events only. Never reads .env or sends messages.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const path = require('node:path');
if (process.env.CRM_QA_ISOLATED !== '1') throw Error('Requires CRM_QA_ISOLATED=1');
(async () => {
 const conn={host:'127.0.0.1',port:55439,user:'postgres'};
 const admin=new Pool({...conn,database:'postgres'}), database='crm_keyword_qa_'+Date.now();
 await admin.query('CREATE DATABASE '+database);
 const pool=new Pool({...conn,database}),query=(s,p)=>pool.query(s,p); let server;
 async function cleanup(){if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();}
 try {
  await query(`CREATE TABLE line_webhook_events(id serial primary key,event_type text,result text,detail text,line_user_id text,event_timestamp timestamptz,created_at timestamptz,raw_event jsonb)`);
  async function event(rule,who,result,at,created,key){await query(`INSERT INTO line_webhook_events(event_type,result,detail,line_user_id,event_timestamp,created_at,raw_event) VALUES('message',$1,$2,$3,$4,$5,$6)`,[result,'rule#'+rule,who,at,created,{webhookEventId:key}]);}
  await event(7,'STAGING-a','keyword_replied','2026-10-05T00:00:00+08:00','2026-10-05','STAGING-start');
  await event(7,'STAGING-a','keyword_replied','2026-10-05T00:00:00+08:00','2026-10-08','STAGING-start');
  await event(7,'STAGING-b','keyword_reply_failed','2026-10-11T23:59:59.999+08:00','2026-10-12','STAGING-end');
  await event(7,'STAGING-c','keyword_replied','2026-10-12T00:00:00+08:00','2026-10-12','STAGING-out');
  await event(7,'STAGING-d','keyword_replied','2026-10-05T10:00:00+08:00','2026-10-09','STAGING-delayed');
  await event(7,'STAGING-a','keyword_ab_duplicate_event','2026-10-05','2026-10-05','STAGING-start');
  await event(7,'STAGING-a','keyword_no_match','2026-10-05','2026-10-05','STAGING-nomatch');
  await event(8,'STAGING-f','keyword_fallback_replied','2026-10-05','2026-10-05','STAGING-fallback');
  const routes={},app={};for(const m of ['get','post','put','delete'])app[m]=(p,...h)=>routes[p]=h;
  const {registerAdminKeywordRepliesRoutes}=require('../../src/routes/adminKeywordReplies');
  registerAdminKeywordRepliesRoutes(app,{query,authCore:{requireAdmin:(_q,_s,n)=>n()}});
  async function stats(params){const res={code:200,setHeader(){},status(c){this.code=c;return this},json(b){this.body=b;return this}};await routes['/admin/keyword-replies/api/stats'].at(-1)({query:params},res);assert.equal(res.code,200);return res.body;}
  const params={from:'2026-10-05',to:'2026-10-11',rule_id:'7',granularity:'day'};
  const r=await stats(params),total=r.totals.find(t=>t.rule_id===7);
  assert.deepEqual(total,{rule_id:7,triggers:3,replied:2,failed:1,people:3});
  assert.equal(r.totals.find(t=>t.rule_id===8).triggers,1);
  assert.deepEqual(r.series.map(x=>[x.bucket,x.triggers]),[['2026-10-05',2],['2026-10-11',1]]);
  assert.equal((await stats({...params,from:'2026-10-05',to:'2026-10-05'})).totals.find(t=>t.rule_id===7).triggers,2,'late processing remains on original event day');
  for(const granularity of ['hour','hour_of_day']){const x=await stats({...params,granularity});assert.equal(x.series.reduce((n,b)=>n+b.triggers,0),3);}
  assert.equal((await stats({...params,from:'2026-09-01',to:'2026-09-01'})).totals.length,0);
  console.log('PASS real PostgreSQL: Taiwan midnight boundaries, ordinary redelivery dedup, delayed processing, fallback, nonmatch exclusion, three bucket modes, empty range');
  if(process.env.CRM_QA_SERVE==='1'){
   const express=require('express'),ui=express();ui.set('views',path.join(__dirname,'../../views'));ui.set('view engine','ejs');ui.use(express.static(path.join(__dirname,'../../public')));ui.use((req,res,next)=>req.method==='GET'?next():res.sendStatus(405));
   ui.use((req,res,next)=>{res.locals.isSafePreview=true;req.authUser={un:'STAGING LOCAL QA'};next();});
   ui.get('/admin/keyword-replies/api/list',(_q,res)=>res.json({ok:true,ab_enabled:false,templates:[],rules:[{id:7,keywords:'STAGING 領取獎勵',match_type:'exact',template_name:'STAGING 獎勵步驟',is_active:false,hit_count:10,priority:10},{id:8,keywords:'',match_type:'fallback',template_name:'STAGING 兜底',is_active:false,hit_count:1,priority:20}]}));
   registerAdminKeywordRepliesRoutes(ui,{query,authCore:{requireAdmin:(_q,_s,n)=>n()}});
   server=ui.listen(3109,'127.0.0.1',()=>console.log('LOCAL_QA_READY :3109'));
   process.once('SIGINT',async()=>{await cleanup();process.exit(0)});return;
  }
 }catch(e){console.error(e);process.exitCode=1;}await cleanup();
})().catch(e=>{console.error(e);process.exitCode=1});
