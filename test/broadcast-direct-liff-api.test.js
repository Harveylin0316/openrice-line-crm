'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDirectLiffHitHandler } = require('../src/routes/broadcastDirectLiff');
const id='1234567890-Abcd',uid='U'+'1'.repeat(32);
const env={BROADCAST_DIRECT_LIFF_APPS:JSON.stringify({[id]:'https://activity.example/index.html'})};
const cfg={mode:'template',template:{title:'QA',subtitle:'QA',ctaLabel:'Open',ctaUrl:'https://liff.line.me/'+id+'?g=B',altText:'QA'}};
function setup({row={},verify,fail=false}={}) {
 const calls=[],auth=[];
 const client={release(){calls.push('release')},async query(sql,args){calls.push({sql,args});if(sql.includes('FOR UPDATE'))return {rows:[{channel:'line',message_config:cfg,recipient_line_user_id:uid,recipient_status:'sent',recipient_variant:'a',...row}]};if(sql.includes('INSERT INTO')){if(fail)throw Error('private database detail');return {rows:[{recorded:true}]}}return {rows:[]}}};
 const handler=createDirectLiffHitHandler({env,pool:{connect:async()=>client},verifyToken:async(...args)=>{auth.push(args);return verify||{ok:true,sub:uid,aud:'1234567890'}}});
 const req={body:{reference:'91.92.0.-',liff_id:id,id_token:'test-token',page_path:'/index.html'},get:k=>k==='origin'?'https://activity.example':k==='user-agent'?'Synthetic QA':'',query:{}};
 const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(b){this.body=b;return this}};
 return {calls,auth,req,res,handler};
}
test('verified recipient is recorded in a transaction with original target and sanitized referer',async()=>{
 const x=setup();await x.handler(x.req,x.res);assert.equal(x.res.code,200);assert.deepEqual(x.res.body,{ok:true,recorded:true});
 assert.equal(x.auth[0][1],'1234567890');assert.equal(x.res.headers['Access-Control-Allow-Origin'],'https://activity.example');
 const insert=x.calls.find(c=>c.sql?.includes('INSERT INTO'));assert.equal(insert.args[2],uid);assert.equal(insert.args[3],cfg.template.ctaUrl);assert.ok(insert.args.includes('https://activity.example/index.html'));
 assert.ok(x.calls.find(c=>c.sql==='COMMIT'));assert.equal(x.calls.at(-1),'release');
});
test('invalid origin, reference, preview and app are rejected without LINE verification or database writes',async()=>{
 for(const alter of [x=>x.req.get=()=> 'https://evil.example',x=>x.req.body.reference='91.92.0.a&secret',x=>x.req.body.liff_id='9999-Other',x=>x.req.body.preview=true,x=>x.req.query.preview='1',x=>x.req.body.page_path='/other.html']){
  const x=setup();alter(x);await x.handler(x.req,x.res);assert.notEqual(x.res.code,200);assert.equal(x.calls.length,0);assert.equal(x.auth.length,0);
 }
});
test('invalid token, wrong channel and missing sub never open a transaction',async()=>{
 for(const verify of [{ok:false},{ok:true,sub:uid,aud:'9999'},{ok:true,aud:'1234567890'}]){const x=setup({verify});await x.handler(x.req,x.res);assert.equal(x.res.code,401);assert.equal(x.calls.length,0);}
});
test('forwarded identity, unsent recipient, wrong variant, email and unapproved target cannot record',async()=>{
 for(const row of [{recipient_line_user_id:'U'+'2'.repeat(32)},{recipient_status:'pending'},{is_ab_test:true,recipient_variant:'b',variant_b_message_config:cfg},{channel:'email'},{message_config:{...cfg,template:{...cfg.template,ctaUrl:'https://example.com'}}}]){
  const x=setup({row});await x.handler(x.req,x.res);assert.equal(x.res.code,403);assert.equal(x.calls.some(c=>c.sql?.includes('INSERT INTO')),false);assert.ok(x.calls.some(c=>c.sql==='ROLLBACK'));
 }
});
test('variant B/C must match the recipient and resolve the saved version',async()=>{
 for(const v of ['b','c']){const x=setup({row:{is_ab_test:true,recipient_variant:v,variant_b_message_config:cfg,audience_config:{experiment:{enabled:true,variantCMessageConfig:cfg}}}});x.req.body.reference='91.92.0.'+v;await x.handler(x.req,x.res);assert.equal(x.res.code,200);assert.equal(x.calls.find(c=>c.sql?.includes('INSERT INTO')).args[5],v);}
});
test('database failure rolls back and reports failure without exposing details',async()=>{
 const x=setup({fail:true});await x.handler(x.req,x.res);assert.equal(x.res.code,503);assert.deepEqual(x.res.body,{ok:false,error:'tracking_unavailable'});assert.ok(x.calls.some(c=>c.sql==='ROLLBACK'));assert.equal(x.calls.at(-1),'release');
});
