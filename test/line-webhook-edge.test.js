const {test}=require('node:test'); const assert=require('node:assert/strict');
const {createHmac,webcrypto}=require('node:crypto');
const secret='synthetic-test-secret', scheduler='synthetic-worker-secret';
const raw=JSON.stringify({events:[{webhookEventId:'QA-edge-1',type:'message'}]});
const sig=b=>createHmac('sha256',secret).update(b).digest('base64');
const req=(b=raw,s=sig(b),url='https://qa--openrice-line-crm.netlify.app/webhooks/line')=>new Request(url,{method:'POST',body:b,headers:{'x-line-signature':s}});
const ctx={site:{name:'openrice-line-crm'},next:async r=>new Response(await r.text(),{status:201})};
async function make(fetcher,env=k=>k==='LINE_CHANNEL_SECRET'?secret:scheduler){const {createEdgeReceiver}=await import('../netlify/edge-functions/line-webhook.mjs');return createEdgeReceiver({env,fetcher,cryptoApi:webcrypto,log:()=>{}});}
test('edge validates raw signature and waits for managed 202 acceptance, never DB or application startup',async()=>{
 let release;const gate=new Promise(r=>release=r);let returned=false;
 const h=await make(async(url,o)=>{assert.match(url.href,/qa--openrice-line-crm/);assert.equal(o.headers['x-scheduler-secret'],scheduler);assert.equal(o.headers['x-line-signature'],sig(raw));assert.equal(new TextDecoder().decode(o.body),raw);await gate;return {status:202};});
 const result=h(req(),ctx).then(r=>{returned=true;return r;});await new Promise(r=>setImmediate(r));assert.equal(returned,false);release();assert.equal((await result).status,200);
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
test('failed or ambiguous worker acceptance never reports success',async()=>{
 assert.equal((await (await make(async()=>({status:500})))(req(),ctx)).status,503);
 assert.equal((await (await make(async()=>{throw Error('network');}))(req(),ctx)).status,503);
});
test('handoff cannot forward the scheduler secret to an arbitrary host',async()=>{
 const h=await make(()=>{throw Error('must not send secret');});assert.equal((await h(req(raw,sig(raw),'https://evil.test/webhooks/line'),ctx)).status,503);
});
test('large valid batches retain raw signature and durable legacy receiver fallback',async()=>{
 const body=JSON.stringify({events:[{webhookEventId:'QA-large',padding:'x'.repeat(100*1024)}]});
 const h=await make(()=>{throw Error('too large for background envelope');});const r=await h(req(body),ctx);assert.equal(r.status,201);assert.equal(await r.text(),body);
});
test('background persists signed handoff before draining; DB failure throws for platform retry',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const inbox=require('../src/core/lineWebhookInbox');
 const code=fs.readFileSync('netlify/functions/line-webhook-worker-background.js','utf8');
 async function run(fail){let saved=false,drained=false;const exports={};
 vm.runInNewContext(code,{exports,Buffer,process:{env:{SCHEDULED_RUNNER_SECRET:scheduler,LINE_CHANNEL_SECRET:secret}},
 require:p=>{if(p.endsWith('lineWebhookInbox'))return {...inbox,createDrain:()=>async()=>{assert.equal(saved,true);drained=true;return {processed:0};}};
 if(p.endsWith('lineWebhookInboxRuntime'))return {query:async()=>{if(fail)throw Error('DB unavailable');saved=true;},wake:async()=>{}};
 if(p.endsWith('orMissionFollow'))return {stagingCaptureEnabled:()=>false};throw Error('unexpected require '+p);}});
 const task=exports.handler({body:raw,headers:{'x-scheduler-secret':scheduler,'x-line-signature':sig(raw)}});
 if(fail){await assert.rejects(task,/line_handoff_persist_failed/);assert.equal(drained,false);}else{await task;assert.equal(drained,true);}}
 await run(false);await run(true);
});
