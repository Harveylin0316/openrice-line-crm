'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineMessages, resolveBroadcastButtonTarget } = require('../src/core/broadcastTemplates');
const LIFF = 'https://liff.line.me/1234567890-Abcd';
const opts = { heroImageBaseUrl: 'https://crm.example', broadcastId: 91, recipientId: 92, variant: 'b' };
const card = uri => ({mode:'flex_json',flex:{type:'flex',altText:'QA',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'QA',uri}}]}}}});
function configured(fn, enabled='1') {
  const old = [process.env.BROADCAST_DIRECT_LIFF_ENABLED,process.env.BROADCAST_DIRECT_LIFF_APPS];
  process.env.BROADCAST_DIRECT_LIFF_ENABLED=enabled;
  process.env.BROADCAST_DIRECT_LIFF_APPS=JSON.stringify({'1234567890-Abcd':'https://activity.example/index.html'});
  try { return fn(); } finally {
    ['BROADCAST_DIRECT_LIFF_ENABLED','BROADCAST_DIRECT_LIFF_APPS'].forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);
  }
}
test('configured LIFF stays direct and preserves original query/hash; snapshots remain unmodified',()=>configured(()=>{
 const uri=LIFF+'?g=B&src=push_click#receipt',cfg=card(uri);
 const actual=buildLineMessages(cfg,opts).messages[0].contents.body.contents[0].action.uri;
 assert.equal(actual,LIFF+'?g=B&src=push_click&or_bc=91.92.0.b#receipt');
 assert.equal(resolveBroadcastButtonTarget(cfg,0).uri,uri);
}));
test('text and imagemap keep historical indices with mixed ordinary links',()=>configured(()=>{
 const cfg={mode:'sequence',items:[{type:'text',text:'QA '+LIFF},{type:'card',message_config:{mode:'imagemap',imagemap:{assetId:'11111111-1111-4111-8111-111111111111',baseWidth:1040,baseHeight:1040,altText:'QA',areas:[{type:'uri',uri:LIFF+'?g=B',x:0,y:0,width:1040,height:1040}]}}},{type:'card',message_config:card('https://example.com/offer')}]};
 const built=buildLineMessages(cfg,opts);assert.equal(built.ok,true);
 assert.equal(built.messages[0].text,'QA '+LIFF+'?or_bc=91.92.2.b');
 assert.equal(built.messages[1].actions[0].linkUri,LIFF+'?g=B&or_bc=91.92.0.b');
 assert.equal(built.messages[2].contents.body.contents[0].action.uri,'https://crm.example/r/b/91/92/1?v=b');
}));
test('legacy template CTA also uses direct entry',()=>configured(()=>{
 const cfg={mode:'template',template:{title:'QA',subtitle:'QA',ctaLabel:'Open',ctaUrl:LIFF,altText:'QA'}};
 const built=buildLineMessages(cfg,opts);
 assert.ok(JSON.stringify(built.messages).includes(LIFF+'?or_bc=91.92.0.b'));
}));
test('disabled flag, unknown app, misleading hostname and preview keep previous behavior',()=>{
 configured(()=>assert.match(JSON.stringify(buildLineMessages(card(LIFF),opts).messages),/\/r\/b\/91\/92\/0/),'0');
 configured(()=>{
  for(const uri of ['https://liff.line.me/9999999999-Other','https://liff.line.me.evil.example/1234567890-Abcd',LIFF+'/other']) assert.match(JSON.stringify(buildLineMessages(card(uri),opts).messages),/\/r\/b\/91\/92\/0/);
  assert.ok(JSON.stringify(buildLineMessages(card(LIFF),{heroImageBaseUrl:opts.heroImageBaseUrl}).messages).includes(LIFF+'"'));
 });
});
