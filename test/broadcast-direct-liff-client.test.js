'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/broadcast-direct-liff.js'),'utf8');
function setup(search='?g=B&src=push_click&or_bc=91.92.0.b') {
 const calls=[],ctx={URLSearchParams,AbortController,setTimeout,clearTimeout,location:{search,protocol:'https:',pathname:'/index.html'},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true}}};
 ctx.window=ctx;vm.runInNewContext(source,ctx);
 const options={liff:{id:'1234567890-Abcd',getIDToken:()=> 'private-test-token'},liffId:'1234567890-Abcd',crmOrigin:'https://staging--openrice-line-crm.netlify.app',preview:false};
 return {ctx,calls,options};
}
test('one non-blocking POST after login, only to fixed CRM origin, with no credentials or referrer',async()=>{
 const x=setup();assert.equal(await x.ctx.OpenRiceBroadcastTracking.record(x.options),true);
 assert.equal(await x.ctx.OpenRiceBroadcastTracking.record(x.options),false);assert.equal(x.calls.length,1);
 const {url,opts}=x.calls[0];assert.equal(url,x.options.crmOrigin+'/tracking/broadcast/liff-hit');assert.equal(opts.method,'POST');assert.equal(opts.credentials,'omit');assert.equal(opts.referrerPolicy,'no-referrer');
 const body=JSON.parse(opts.body);assert.equal(body.reference,'91.92.0.b');assert.equal(body.id_token,'private-test-token');assert.equal(body.page_path,'/index.html');assert.equal(body.liff_id,x.options.liffId);assert.equal(Object.keys(body).length,4);
});
test('demo, preview, absent/malformed/duplicate reference, HTTP, wrong app/origin and missing token do not send',async()=>{
 for(const change of [x=>x.options.preview=true,x=>x.ctx.location.search+='&demo=1',x=>x.ctx.location.search+='&preview=1',x=>x.ctx.location.search='',x=>x.ctx.location.search='?or_bc=invalid',x=>x.ctx.location.search+='&or_bc=91.92.0.b',x=>x.ctx.location.protocol='http:',x=>x.options.liffId='9999-Other',x=>x.options.crmOrigin='https://evil.example',x=>x.options.liff.getIDToken=()=>null]){
  const x=setup();change(x);assert.equal(await x.ctx.OpenRiceBroadcastTracking.record(x.options),false);assert.equal(x.calls.length,0);
 }
});
test('SDK, network and HTTP errors are contained without changing navigation or closing the activity',async()=>{
 for(const change of [x=>x.options.liff.getIDToken=()=>{throw Error('SDK failure')},x=>x.ctx.fetch=async()=>{throw Error('network failure')},x=>x.ctx.fetch=async()=>({ok:false})]){
  const x=setup();change(x);x.options.liff.closeWindow=()=>assert.fail('must not close');const before=JSON.stringify(x.ctx.location);
  assert.equal(await x.ctx.OpenRiceBroadcastTracking.record(x.options),false);assert.equal(JSON.stringify(x.ctx.location),before);
 }
});
