const {test}=require('node:test'); const assert=require('node:assert/strict');
const {createHmac,webcrypto}=require('node:crypto');
const secret='synthetic-test-secret', scheduler='synthetic-worker-secret';
const raw=JSON.stringify({events:[{webhookEventId:'QA-edge-1',type:'message'}]});
const sig=b=>createHmac('sha256',secret).update(b).digest('base64');
const req=(b=raw,s=sig(b),url='https://qa--openrice-line-crm.netlify.app/webhooks/line')=>new Request(url,{method:'POST',body:b,headers:{'x-line-signature':s}});
const ctx={site:{name:'openrice-line-crm'},next:async r=>new Response(await r.text(),{status:201})};
async function make(fetcher,env=k=>k==='LINE_CHANNEL_SECRET'?secret:scheduler){const {createEdgeReceiver}=await import('../netlify/edge-functions/line-webhook.mjs');return createEdgeReceiver({env,fetcher,cryptoApi:webcrypto,log:()=>{}});}
test('edge validates raw signature then continues original POST through native background rewrite',async()=>{
 const h=await make(()=>{throw Error('must not self-fetch normal events');});const request=req();let called=false;
 const result=await h(request,{...ctx,next:async r=>{called=true;assert.equal(r.method,'POST');assert.equal(await r.text(),raw);assert.equal(r.headers.get('x-line-signature'),sig(raw));return new Response(null,{status:202});}});
 assert.equal(called,true);assert.equal(result.status,202);
 const toml=require('node:fs').readFileSync('netlify.toml','utf8');assert.match(toml,/from = "\/webhooks\/line"\s+to = "\/.netlify\/functions\/line-webhook-worker-background"/);
});
test('invalid signatures, mutated payload, malformed JSON and missing config cannot enqueue',async()=>{
 const h=await make(()=>{throw Error('must not enqueue');});
 assert.equal((await h(req(raw,'bogus'),ctx)).status,401);
 assert.equal((await h(req(raw+' ',sig(raw)),ctx)).status,401);
 assert.equal((await h(req('{',sig('{')),ctx)).status,400);
 assert.equal((await (await make(()=>{},()=>''))(req(),ctx)).status,503);
});
test('empty LINE verification request returns 200 without queue; bad event IDs rejected',async()=>{
 const h=await make(()=>{throw Error('no work');});assert.equal((await h(req('{"events":[]}'),ctx)).status,200);
 assert.equal((await h(req('{"events":[{}]}'),ctx)).status,400);
});
test('native routing preserves platform rejection instead of manufacturing accepted status',async()=>{
 const h=await make(()=>{throw Error('must not self-fetch');});const result=await h(req(),{...ctx,next:async()=>new Response(null,{status:503})});assert.equal(result.status,503);
});
test('handoff cannot forward the scheduler secret to an arbitrary host',async()=>{
 const h=await make(()=>{throw Error('must not send secret');});assert.equal((await h(req(raw,sig(raw),'https://evil.test/webhooks/line'),ctx)).status,503);
});
test('large valid batches retain raw signature and durable legacy receiver fallback',async()=>{
 const body=JSON.stringify({events:[{webhookEventId:'QA-large',padding:'x'.repeat(100*1024)}]});
 const h=await make(async(u,o)=>{assert.match(u.pathname,/line-webhook-receiver$/);assert.equal(new TextDecoder().decode(o.body),body);assert.equal(o.headers['x-line-signature'],sig(body));return new Response(o.body,{status:201});});const r=await h(req(body),ctx);assert.equal(r.status,201);assert.equal(await r.text(),body);
});
test('background persists signed handoff before draining; DB failure throws for platform retry',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const inbox=require('../src/core/lineWebhookInbox');
 const code=fs.readFileSync('netlify/functions/line-webhook-worker-background.js','utf8');
 async function run(fail,internal=true){let saved=false,drained=false;const exports={};
 vm.runInNewContext(code,{exports,Buffer,console:{info(){}},process:{env:{SCHEDULED_RUNNER_SECRET:scheduler,LINE_CHANNEL_SECRET:secret}},
 require:p=>{if(p.endsWith('lineWebhookInbox'))return {...inbox,createDrain:()=>async()=>{assert.equal(saved,true);drained=true;return {processed:0};}};
 if(p.endsWith('lineWebhookInboxRuntime'))return {createRuntime:()=>({query:async()=>{if(fail)throw Error('DB unavailable');saved=true;},wake:async()=>{}})};
 if(p.endsWith('orMissionFollow'))return {stagingCaptureEnabled:()=>false};throw Error('unexpected require '+p);}});
 const task=exports.handler({body:raw,headers:{...(internal?{'x-scheduler-secret':scheduler}:{}),'x-line-signature':sig(raw)}});
 if(fail){await assert.rejects(task,/line_handoff_persist_failed/);assert.equal(drained,false);}else{await task;assert.equal(drained,true);}}
 await run(false);await run(true);await run(false,false);await run(true,false);
});
test('public native background target rejects absent or forged LINE signature before DB or app',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const code=fs.readFileSync('netlify/functions/line-webhook-worker-background.js','utf8');const exports={};
 vm.runInNewContext(code,{exports,Buffer,process:{env:{SCHEDULED_RUNNER_SECRET:scheduler,LINE_CHANNEL_SECRET:secret}},
 require:p=>{if(p.endsWith('lineWebhookInbox'))return {...require('../src/core/lineWebhookInbox'),createDrain:()=>{throw Error('must not process');}};
 if(p.endsWith('lineWebhookInboxRuntime'))return {createRuntime:()=>({query:async()=>{throw Error('must not write');}})};throw Error('must not load app');}});
 await exports.handler({body:raw,headers:{}});await exports.handler({body:raw,headers:{'x-line-signature':'forged'}});
});
