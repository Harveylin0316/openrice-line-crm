const test=require('node:test');const assert=require('node:assert/strict');
test('tracking targets preserve same-image variant URLs and text punctuation without changing input',()=>{
 const {collectMessageTargets,wrapExecutionTargets}=require('../src/core/messageTrackingTargets');
 const a=[{type:'text',text:'請看 https://example.com/?variant=b&utm_source=line，謝謝'},{type:'imagemap',baseUrl:'https://example.com/same',actions:[{type:'uri',linkUri:'https://example.com/?variant=a',area:{x:0,y:0,width:1040,height:1040}}]}];
 const {targets}=collectMessageTargets(a);assert.equal(targets[0].uri,'https://example.com/?variant=a');assert.equal(targets[1].uri,'https://example.com/?variant=b&utm_source=line');
 const out=wrapExecutionTargets(a,targets,i=>'https://example.com/t/e/STAGING/'+i);
 assert.equal(out[1].actions[0].linkUri,'https://example.com/t/e/STAGING/0');assert.equal(out[0].text,'請看 https://example.com/t/e/STAGING/1，謝謝');assert.match(a[1].actions[0].linkUri,/variant=a/);
});

test('broadcast and keyword targets append text URLs without changing old action indices',()=>{
 const {listUriButtons,walkUriActions}=require('../src/core/messageTapTracking');
 const cfg={contents:[{type:'text',text:'前 https://example.com/?v=a。後'}, {type:'flex',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'Open',uri:'https://example.com/card'}}]}}}]};
 const opts={includeOwnLiff:true,includeTextUrls:true};const list=listUriButtons(cfg,opts);
 assert.equal(list.length,2);assert.equal(list[0].uri,'https://example.com/card');assert.equal(list[1].uri,'https://example.com/?v=a');
 walkUriActions(cfg,t=>'https://example.com/r/'+t.index,opts);assert.equal(cfg.contents[0].text,'前 https://example.com/r/1。後');
});
test('existing keyword experiments never wrap a newly discovered text target missing from their snapshot',()=>{
 const {buildExperimentMessages}=require('../src/core/keywordExperiments');
 const cfg={mode:'sequence',items:[{type:'text',text:'STAGING https://example.com/old'}]};
 const built=buildExperimentMessages(cfg,{origin:'https://example.com',deliveryCode:'STAGINGcode',liffId:'STAGING-liff',targets:[]});
 assert.equal(built.messages[0].text,'STAGING https://example.com/old');
});
test('execution tracker GET is read-only and unsigned/forwarded hits never write',async()=>{
 const {registerMessageExecutionTracking}=require('../src/routes/messageExecutionTracking');const routes={},writes=[];
 registerMessageExecutionTracking({get(p,h){routes['GET '+p]=h},post(p,h){routes['POST '+p]=h}},{query:async(sql,p)=>{
  if(sql.startsWith('SELECT'))return {rows:[{id:1,code:'STAGING'.padEnd(32,'x'),status:'accepted',recipient_key:'STAGING_OWNER',targets:[{index:0,uri:'https://example.com/?variant=b',tracked:true}]}]};writes.push(sql);return {rows:[]};
 }});
 const req={params:{code:'STAGING'.padEnd(32,'x'),index:'0'},body:{}};const res={status(n){this.code=n;return this},json(b){this.body=b;return this},setHeader(){},render(v,b){this.view=v;this.data=b},send(){}};
 await routes['GET /t/e/:code/:index'](req,res);assert.equal(res.data.target,'https://example.com/?variant=b');assert.equal(writes.length,0);
 await routes['POST /t/e/:code/:index/hit'](req,res);assert.equal(res.code,403);assert.equal(writes.length,0);
});
