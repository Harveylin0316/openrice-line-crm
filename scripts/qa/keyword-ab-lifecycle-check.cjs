'use strict';
// Isolated localhost QA only. Every scenario rolls back; no LINE calls or remote credentials.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('pg');
const {registerAdminKeywordExperimentRoutes}=require('../../src/routes/adminKeywordExperiments');
const port=Number(process.env.KEYWORD_AB_TEST_PORT);
if(port!==55439)throw Error('Set KEYWORD_AB_TEST_PORT=55439 for the isolated QA cluster only');
const makeClient=()=>new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
const templates={1:{id:1,name:'QA A',message_config:{mode:'sequence',items:[{type:'text',text:'QA A'}]}},2:{id:2,name:'QA B',message_config:{mode:'sequence',items:[{type:'text',text:'QA B'}]}}};
function harness(query){
 const handlers={};
 registerAdminKeywordExperimentRoutes({get(){},post(p,...h){handlers[p]=h.at(-1);}},{authCore:{requireAdmin:(_q,_s,n)=>n()},resolvePublicSiteOrigin:()=> 'https://qa.example',query:async(sql,p)=>{
  if(sql.includes('FROM admin_keyword_replies WHERE id'))return {rows:[{id:7,is_active:true}]};
  if(sql.includes('FROM admin_message_templates WHERE id'))return {rows:[templates[p[0]]]};
  return query(sql,p);
 }});
 return async(action,id,body={})=>{
  const key=Object.keys(handlers).find(k=>action==='create'?k.includes(':ruleId'):k.includes(':action'));
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};
  await handlers[key]({authUser:{un:'synthetic-qa'},params:{ruleId:'7',id:String(id),action},body},res);return res;
 };
}
const body={name:'SYNTHETIC QA',a_template_id:1,b_template_id:2,duration_days:7};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
(async()=>{
 const db=makeClient();await db.connect();
 try {
  for(const status of ['running','paused']){
   await db.query('BEGIN; SET LOCAL search_path=crm_staging');
   await db.query('INSERT INTO admin_keyword_replies(id) VALUES(7) ON CONFLICT DO NOTHING');
   const expired=(await db.query(`INSERT INTO keyword_reply_experiments(rule_id,name,status,variant_a_config,variant_b_config,start_at,end_at)
     VALUES(7,'SYNTHETIC expired',$1,'{}','{}',now()-interval '2 days',now()-interval '1 day') RETURNING *`,[status])).rows[0];
   const call=harness((s,p)=>db.query(s,p));
   const bad=await call('create',0,{...body,start_at:'invalid'});assert.equal(bad.statusCode,400);
   const result=await call('create',0,body);assert.equal(result.body.ok,true,JSON.stringify(result.body));
   const old=(await db.query('SELECT * FROM keyword_reply_experiments WHERE id=$1',[expired.id])).rows[0];
   assert.equal(old.status,'ended');assert.ok(old.ended_at);assert.equal(old.change_log.at(-1).action,'expire');
   await db.query('SAVEPOINT duplicate');
   const again=await call('create',0,body);assert.equal(again.statusCode,409);
   await db.query('ROLLBACK TO SAVEPOINT duplicate');
   await db.query('ROLLBACK');
   console.log('PASS expired '+status+': next test created; old ended with audit; active duplicate rejected');
  }
  await db.query('BEGIN; SET LOCAL search_path=crm_staging');
  await db.query('INSERT INTO admin_keyword_replies(id) VALUES(7) ON CONFLICT DO NOTHING');
  const expired=(await db.query(`INSERT INTO keyword_reply_experiments(rule_id,name,variant_a_config,variant_b_config,start_at,end_at)
    VALUES(7,'SYNTHETIC close','{}','{}',now()-interval '2 days',now()-interval '1 day') RETURNING *`)).rows[0];
  const close=await harness((s,p)=>db.query(s,p))('end',expired.id);assert.equal(close.body.ok,true);
  await db.query('ROLLBACK');console.log('PASS expired end: API can safely finalize expired row');
  for(const winner of ['end','resume']){
   await db.query('BEGIN; SET LOCAL search_path=crm_staging');
   await db.query('INSERT INTO admin_keyword_replies(id) VALUES(7) ON CONFLICT DO NOTHING');
   const exp=(await db.query(`INSERT INTO keyword_reply_experiments(rule_id,name,status,variant_a_config,variant_b_config,start_at,end_at)
    VALUES(7,'SYNTHETIC race','paused','{}','{}',now()-interval '1 day',now()+interval '1 day') RETURNING *`)).rows[0];
   const readGate=deferred(),firstWritten=deferred();let reads=0;
   const call=harness(async(s,p)=>{
    if(s.startsWith('SELECT *')){const r=await db.query(s,p);if(++reads===2)readGate.resolve();await readGate.promise;return r;}
    if(s.startsWith('UPDATE ')){
     const isWinner=p[1]===(winner==='end'?'ended':'running');if(!isWinner)await firstWritten.promise;
     const r=await db.query(s,p);if(isWinner)firstWritten.resolve();return r;
    }
    return db.query(s,p);
   });
   const [end,resume]=await Promise.all([call('end',exp.id),call('resume',exp.id)]);
   assert.equal(winner==='end'?end.statusCode:resume.statusCode,200);
   assert.equal(winner==='end'?resume.statusCode:end.statusCode,409);
   let final=(await db.query('SELECT * FROM keyword_reply_experiments WHERE id=$1',[exp.id])).rows[0];
   assert.equal(final.status,winner==='end'?'ended':'running');
   if(winner==='resume'){
    assert.equal((await harness((s,p)=>db.query(s,p))('end',exp.id)).body.ok,true);
    final=(await db.query('SELECT * FROM keyword_reply_experiments WHERE id=$1',[exp.id])).rows[0];assert.equal(final.status,'ended');
   }
   await db.query('ROLLBACK');console.log('PASS end/resume '+winner+' first: losing stale action 409; ended state not resurrected');
  }
  // Separate committed connections prove xmin changes between real requests (not just mocks).
  const schema='keyword_ab_lifecycle_qa';
  assert.equal((await db.query('SELECT to_regnamespace($1) AS n',[schema])).rows[0].n,null,'Never overwrite an existing QA schema');
  await db.query('CREATE SCHEMA '+schema);
  const connections=[];
  try {
   await db.query('SET search_path='+schema);
   await db.query('CREATE TABLE admin_keyword_replies(id integer PRIMARY KEY); INSERT INTO admin_keyword_replies VALUES(7)');
   await db.query(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261002090000_keyword_reply_ab_tests.sql'),'utf8'));
   for(let i=0;i<5;i++){const c=makeClient();await c.connect();await c.query('SET search_path='+schema);connections.push(c);}
   const call=harness((s,p)=>db.query(s,p));
   const created=await call('create',0,body);assert.equal(created.body.ok,true);
   const exp=created.body.experiment;
   const ke=require('../../src/core/keywordExperiments');const uid='U'+'a'.repeat(32);
   const assigned=await Promise.all(connections.map(c=>ke.assignVariant((s,p)=>c.query(s,p),exp.id,uid)));
   assert.equal(assigned.filter(x=>x.isNew).length,1);assert.equal(new Set(assigned.map(x=>x.variant)).size,1);
   const deliveries=await Promise.all(connections.map(c=>ke.claimDelivery((s,p)=>c.query(s,p),{experimentId:exp.id,lineUserId:uid,variant:assigned[0].variant,webhookEventId:'SYNTHETIC same event'})));
   assert.equal(deliveries.filter(Boolean).length,1);
   console.log('PASS five real connections: one fixed assignment; one delivery claim per repeated event');
   const gate=deferred(),firstWritten=deferred();let reads=0;
   function concurrent(c){return harness(async(s,p)=>{
    if(s.startsWith('SELECT *')){const r=await c.query(s,p);if(++reads===2)gate.resolve();await gate.promise;return r;}
    if(s.startsWith('UPDATE ')){const first=p[1]===new Date(new Date(exp.end_at).getTime()+86400000).toISOString();if(!first)await firstWritten.promise;const r=await c.query(s,p);if(first)firstWritten.resolve();return r;}
    return c.query(s,p);
   });}
   const end1=new Date(new Date(exp.end_at).getTime()+86400000).toISOString(),end2=new Date(new Date(exp.end_at).getTime()+2*86400000).toISOString();
   const [first,stale]=await Promise.all([concurrent(connections[0])('extend',exp.id,{end_at:end1}),concurrent(connections[1])('extend',exp.id,{end_at:end2})]);
   assert.equal(first.statusCode,200);assert.equal(stale.statusCode,409);
   console.log('PASS separate transactions: stale concurrent extension rejected by row version');
   assert.equal((await call('end',exp.id)).body.ok,true);
   const simultaneous=await Promise.all(connections.slice(0,2).map(c=>harness((s,p)=>c.query(s,p))('create',0,body)));
   assert.deepEqual(simultaneous.map(x=>x.statusCode).sort(),[200,409]);
   console.log('PASS concurrent create: exactly one new open experiment');
  }finally{
   await Promise.all(connections.map(c=>c.end()));await db.query('SET search_path=public');
   // This exact schema was created above by this run and contains synthetic QA data only.
   await db.query('DROP SCHEMA '+schema+' CASCADE');
  }
 }finally{await db.query('ROLLBACK');await db.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
