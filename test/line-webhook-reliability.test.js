const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../src/core/lineWebhookInboxRuntime');
const {createClaim,createDrain}=require('../src/core/lineWebhookInbox');

test('background DB budget is separate from fast HTTP receiver; no pool before use',async()=>{
 const configs=[];
 class FakePool {constructor(c){configs.push(c);}on(){}async query(){return {rows:[]};}}
 const options={env:{DATABASE_URL:'postgres://synthetic.invalid/qa'},PoolClass:FakePool};
 const fast=createRuntime(options),worker=createRuntime({...options,worker:true});
 assert.equal(configs.length,0);await fast.query('SELECT 1');await worker.query('SELECT 1');
 assert.equal(configs[0].connectionTimeoutMillis,500);assert.equal(configs[0].query_timeout,650);
 assert.equal(configs[1].connectionTimeoutMillis,3000);assert.equal(configs[1].statement_timeout,5000);
 assert.equal(configs[1].query_timeout,6000);assert.equal(configs[1].max,1);
});
test('isolated worker wake stays on its deployment, refuses missing isolation origin and redirects',async()=>{
 const urls=[];const fetcher=async(u,o)=>{urls.push(u.href);assert.equal(o.redirect,'error');return {status:202};};
 const env={APP_ENV:'staging',URL:'https://prod.invalid',DEPLOY_URL:'https://qa.invalid',SCHEDULED_RUNNER_SECRET:'synthetic'};
 await createRuntime({env,fetcher}).wake();assert.match(urls[0],/^https:\/\/qa.invalid\//);
 await assert.rejects(createRuntime({env:{...env,DEPLOY_URL:''},fetcher}).wake(),/missing_worker_config/);
 await createRuntime({env:{...env,APP_ENV:'production'},fetcher}).wake();assert.match(urls[1],/^https:\/\/prod.invalid\//);
 await assert.rejects(createRuntime({env,fetcher:async()=>({status:302})}).wake(),/worker_not_accepted/);
});
test('claim retries only the known rolled-back per-user collision, before any event processing',async()=>{
 let calls=0;const collision=Object.assign(Error('synthetic contention'),{code:'23505',constraint:'line_webhook_inbox_active_user'});
 const claim=createClaim({query:async()=>{calls++;if(calls===1)throw collision;return {rows:[]};}});
 assert.deepEqual(await claim(),{rows:[]});assert.equal(calls,2);
 calls=0;assert.deepEqual(await createClaim({query:async()=>{calls++;throw collision;}})(),{rows:[]});assert.equal(calls,3);
 for(const error of [Object.assign(Error('other unique'),{code:'23505',constraint:'other'}),Error('DB unavailable')]){
  calls=0;await assert.rejects(createClaim({query:async()=>{calls++;throw error;}})());assert.equal(calls,1);
 }
});
test('budget exhaustion below batch limit is reported, ambiguous event remains uncertain',async()=>{
 let clock=0,claimed=false;
 const drain=createDrain({now:()=>clock,query:async()=>({rows:[]}),claim:async()=>{if(claimed)return {rows:[]};claimed=true;return {rows:[{event_id:'QA',payload:{}}]};},processEvent:async()=>{clock=50;return false;}});
 assert.deepEqual(await drain({budgetMs:40}),{processed:1,uncertain:1,budgetExhausted:true});
});
test('background wakes next batch on time budget even below 20; no unnecessary wake for idle worker',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const code=fs.readFileSync('netlify/functions/line-webhook-worker-background.js','utf8');
 for(const budgetExhausted of [false,true]){
  let wakes=0;const exports={};vm.runInNewContext(code,{exports,console:{info(){}},process:{env:{LINE_CHANNEL_SECRET:'QA',SCHEDULED_RUNNER_SECRET:'QA'}},require:p=>{
   if(p.endsWith('lineWebhookInbox'))return {equal:(a,b)=>a===b,createDrain:o=>{assert.equal(typeof o.claim,'function');return async()=>({processed:1,uncertain:0,budgetExhausted});}};
   if(p.endsWith('lineWebhookInboxRuntime'))return {createRuntime:o=>{assert.equal(o.worker,true);return {query:async()=>{},claim:async()=>{},wake:async()=>{wakes++;}};}};
   throw Error('unexpected application load');
  }});await exports.handler({headers:{'x-scheduler-secret':'QA'}});assert.equal(wakes,budgetExhausted?1:0);
 }
});
test('optional profile enrichment has a two-second deadline including response body',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const code=fs.readFileSync('src/core/oaFollower.js','utf8');
 let timeout;const module={exports:{}};
 vm.runInNewContext(code,{module,console:{error(){}},process:{env:{LINE_CHANNEL_ACCESS_TOKEN:'synthetic'}},AbortSignal:{timeout:ms=>{timeout=ms;return 'QA-signal';}},fetch:async(u,o)=>{assert.equal(o.signal,'QA-signal');return {ok:true,json:async()=>{throw Error('slow body');}};}});
 assert.equal(await module.exports.fetchOaProfile('QA-user'),null);assert.equal(timeout,2000);
});
test('minute rescue exposes delayed queue in logs, wakes pending work and stays quiet when empty',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const code=fs.readFileSync('netlify/functions/scheduled-line-webhook-runner.js','utf8');
 for(const state of [{oldest_pending_seconds:null,interrupted:false},{oldest_pending_seconds:0,interrupted:false},{oldest_pending_seconds:35,interrupted:false},{oldest_pending_seconds:null,interrupted:true}]){
  let wakes=0;const logs=[],exports={};vm.runInNewContext(code,{exports,process:{env:{SCHEDULED_RUNNER_SECRET:'synthetic'}},console:{warn:s=>logs.push(JSON.parse(s))},require:()=>({query:async sql=>{assert.match(sql,/ORDER BY received_at,event_id LIMIT 1/);return {rows:[state]};},wake:async()=>{wakes++;}})});
  assert.equal((await exports.runRescue()).statusCode,200);assert.equal(wakes,state.oldest_pending_seconds!==null||state.interrupted?1:0);
  assert.equal(logs.length,state.oldest_pending_seconds>=30||state.interrupted?1:0);
  assert.doesNotMatch(JSON.stringify(logs),/replyToken|userId|synthetic/);
 }
});
test('legacy LINE reply and push have bounded requests and never retry ambiguous sends',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const code=fs.readFileSync('src/core/linePush.js','utf8');
 const timeouts=[];let requests=0;const module={exports:{}};
 vm.runInNewContext(code,{module,require,console:{error(){}},AbortSignal:{timeout:ms=>{timeouts.push(ms);return 'QA-deadline';}},fetch:async(u,o)=>{requests++;assert.equal(o.signal,'QA-deadline');throw Error('synthetic timeout');}});
 const logs=[];const service=module.exports.createLinePushService({lineChannelAccessToken:'synthetic',query:async(s,p)=>logs.push(p)});
 assert.equal(await service.replyLineMessages('QA-reply',[{type:'text',text:'QA'}]),false);
 assert.equal(await service.pushLineMessages('QA-user',[{type:'text',text:'QA'}]),false);
 assert.equal(await service.replyLineMessages('QA-reply',[{type:'text',text:'QA'}],{timeoutMs:1200}),false);
 assert.deepEqual(timeouts,[8000,8000,1200]);assert.equal(requests,3);assert.equal(logs.length,3);assert.ok(logs.every(p=>p[3]==='failed'));
});
