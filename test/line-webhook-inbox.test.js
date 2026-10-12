const test = require('node:test');
const assert = require('node:assert/strict');
const {createReceiver,createDrain,signature} = require('../src/core/lineWebhookInbox');
const secret='QA-only-channel-secret';
function event(events=[{webhookEventId:'QA-1',type:'message'}]) {
 const body=JSON.stringify({destination:'QA',events});
 return {httpMethod:'POST',body,headers:{'X-Line-Signature':signature(body,secret)}};
}
test('receiver verifies original bytes before DB, including base64 bodies; verification creates no jobs',async()=>{
 let calls=0;const receive=createReceiver({channelSecret:secret,query:async()=>{calls++;}});
 const bad=event();bad.body+=' ';assert.equal((await receive(bad)).statusCode,401);assert.equal(calls,0);
 assert.equal((await receive(event([]))).statusCode,200);assert.equal(calls,0);
 const e=event();e.body=Buffer.from(e.body).toString('base64');e.isBase64Encoded=true;
 assert.equal((await receive(e)).statusCode,200);assert.equal(calls,1);
});
test('persist failure is non-2xx, invalid IDs rejected, successful persist survives failed wake',async()=>{
 assert.equal((await createReceiver({channelSecret:secret,query:async()=>{throw Error('DB');}})(event())).statusCode,503);
 assert.equal((await createReceiver({channelSecret:secret,query:async()=>{throw Error('must not call');}})(event([{}]))).statusCode,400);
 let saved=false;const r=createReceiver({channelSecret:secret,query:async()=>{saved=true;},wake:async()=>{assert.equal(saved,true);throw Error('wake');}});
 assert.equal((await r(event())).statusCode,200);
});
test('receiver never invokes full event processing before acknowledgement',async()=>{
 let finish;let processingFinished=false;
 const slow=new Promise(r=>{finish=()=>{processingFinished=true;r();};});
 const r=createReceiver({channelSecret:secret,query:async()=>{},wake:async()=>{void slow;}});
 assert.equal((await r(event())).statusCode,200);assert.equal(processingFinished,false);finish();
});
test('worker awaits processing; failure marks uncertain and is never blindly retried',async()=>{
 let claimed=false;const finishes=[];
 const query=async(sql,p)=>{
  if(sql.includes('RETURNING event_id')){if(claimed)return {rows:[]};claimed=true;return {rows:[{event_id:'QA',payload:{events:[]}}]};}
  if(sql.startsWith('UPDATE line_webhook_inbox SET status=$2'))finishes.push(p);
  return {rows:[]};
 };
 const drain=createDrain({query,processEvent:async()=>{throw Error('ambiguous');}});
 assert.equal((await drain()).processed,1);assert.deepEqual(finishes,[['QA','uncertain','handler_failed_no_blind_retry']]);
 assert.equal((await drain()).processed,0);
});
