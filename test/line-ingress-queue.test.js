const {test}=require('node:test');const assert=require('node:assert/strict');
const {createHmac,webcrypto}=require('node:crypto');
const secret='synthetic-ingress-secret';
const raw=JSON.stringify({destination:'QA-bot',events:[{webhookEventId:'QA-queue-1',type:'qa_probe'}]});
const sig=b=>createHmac('sha256',secret).update(b).digest('base64');
const req=(b=raw,s=sig(b))=>new Request('https://qa.test/webhooks/line',{method:'POST',body:b,headers:{'x-line-signature':s}});
const env=(send=async()=>{})=>({MODE:'qa',ENABLED:'1',NETLIFY_ORIGIN:'https://staging--openrice-line-crm.netlify.app',LINE_CHANNEL_SECRET:secret,LINE_QUEUE:{send}});
const make=async(fetcher=()=>{throw Error('unexpected network');},log=()=>{})=>(await import('../cloudflare/line-ingress/worker.mjs')).createIngress({fetcher,cryptoApi:webcrypto,log});
test('ingress cannot acknowledge before durable queue write resolves',async()=>{
 let release,envelope,complete=false;const blocked=new Promise(r=>release=r);
 const h=await make();const task=h.fetch(req(),env(async e=>{envelope=e;await blocked;})).then(r=>{complete=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(complete,false);release();
 assert.equal((await task).status,200);assert.equal(Buffer.from(envelope.raw,'base64').toString(),raw);assert.equal(envelope.signature,sig(raw));
});
test('queue failure stays non-success, invalid signature and malformed payload never enqueue',async()=>{
 const h=await make();let writes=0;const e=env(async()=>{writes++;throw Error('queue unavailable');});
 assert.equal((await h.fetch(req(),e)).status,503);assert.equal(writes,1);
 for(const request of [req(raw,'forged'),req(raw+' ',sig(raw)),req('{'),req('{"events":[{}]}')])assert.ok([400,401].includes((await h.fetch(request,e)).status));
 assert.equal(writes,1);
});
test('empty verification has no queue write; disabled, misrouted and missing secrets fail closed',async()=>{
 const h=await make();let writes=0;const e=env(async()=>writes++);
 assert.equal((await h.fetch(req('{"events":[]}'),e)).status,200);assert.equal(writes,0);
 for(const change of [{ENABLED:'0'},{LINE_CHANNEL_SECRET:''},{NETLIFY_ORIGIN:'https://evil.test'},{MODE:'production'}])assert.equal((await h.fetch(req(),{...e,...change})).status,503);
});
test('large batches use signed durable legacy receiver and preserve failure',async()=>{
 const body=JSON.stringify({events:[{webhookEventId:'QA-big',padding:'x'.repeat(90*1024)}]});let calls=0;
 const h=await make(async(url,o)=>{calls++;assert.equal(url,'https://staging--openrice-line-crm.netlify.app/.netlify/functions/line-webhook-receiver');assert.equal(o.redirect,'manual');assert.equal(Buffer.from(o.body).toString(),body);assert.equal(o.headers['x-line-signature'],sig(body));return new Response(null,{status:503});});
 assert.equal((await h.fetch(req(body),env())).status,503);assert.equal(calls,1);
 assert.equal((await h.fetch(req('x'.repeat(257*1024)),env())).status,413);
});
test('relay awaits Netlify durable acceptance and keeps original signed bytes',async()=>{
 let release,ack=0,retry=0;const wait=new Promise(r=>release=r);
 const h=await make(async(url,o)=>{assert.equal(url,'https://staging--openrice-line-crm.netlify.app/.netlify/functions/line-webhook-worker-background');assert.equal(Buffer.from(o.body).toString(),raw);assert.equal(o.headers['x-line-signature'],sig(raw));assert.equal(o.redirect,'manual');await wait;return new Response(null,{status:202});});
 const task=h.queue({messages:[{body:{version:1,raw:Buffer.from(raw).toString('base64'),signature:sig(raw)},ack(){ack++;},retry(){retry++;}}]},env());
 await new Promise(r=>setImmediate(r));assert.equal(ack,0);release();await task;assert.equal(ack,1);assert.equal(retry,0);
});
test('relay failures, unknown outcomes, forged envelopes and unexpected 200 are retried, not dropped',async()=>{
 for(const kind of ['throw','503','200','302','forged']){
  let ack=0,retry=0;const h=await make(async()=>{if(kind==='throw')throw Error('unknown transport');return new Response(null,{status:Number(kind)});});
  await h.queue({messages:[{attempts:1,body:{version:1,raw:Buffer.from(raw).toString('base64'),signature:kind==='forged'?'forged':sig(raw)},ack(){ack++;},retry(o){assert.ok(o.delaySeconds>0);retry++;}}]},env());
  assert.equal(ack,0);assert.equal(retry,1);
 }
});
test('retry of one message does not prevent acceptance of another; logs contain no payload',async()=>{
 const logs=[];let call=0;const h=await make(async()=>new Response(null,{status:++call===1?503:202}),s=>logs.push(s));const actions=[];
 const body={version:1,raw:Buffer.from(raw).toString('base64'),signature:sig(raw)};
 await h.queue({messages:[0,1].map(i=>({body,ack(){actions.push('ack'+i);},retry(){actions.push('retry'+i);}}))},env());
 assert.deepEqual(actions,['retry0','ack1']);assert.deepEqual(logs.map(JSON.parse),[{event:'line_ingress_relay_deferred',stage:'http_503'}]);
});
