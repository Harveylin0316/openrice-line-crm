const test=require('node:test');const assert=require('node:assert/strict');
test('execution store keeps snapshots and only claims an event once',async()=>{
 const {createMessageExecutionStore}=require('../src/core/messageExecutions');
 let stored=null;const query=async(sql,p)=>{if(sql.includes('INSERT')){if(stored)return {rows:[]};stored={id:1,code:p[0],status:'pending',message_snapshot:JSON.parse(p[5])};return {rows:[stored]};}return {rows:stored?[stored]:[]};};
 const store=createMessageExecutionStore({query}); const cfg={mode:'sequence',items:[{type:'text',text:'STAGING'}]};
 const input={sourceType:'welcome',sourceId:1,sourceEventId:'STAGING_EVENT',recipientKey:'STAGING_RECIPIENT',messageSnapshot:cfg};
 assert.equal((await store.claim({query},input)).claimed,true);cfg.items[0].text='changed';assert.equal(stored.message_snapshot.items[0].text,'STAGING');assert.equal((await store.claim({query},input)).claimed,false);
 await assert.rejects(()=>store.finish(1,{status:'delivered'}));
});
test('content revision remains stable for the same snapshot and separates changed messages',()=>{
 const {snapshotRevision}=require('../src/core/messageExecutions');
 const a={mode:'sequence',items:[{type:'text',text:'STAGING A'}]};const b={mode:'sequence',items:[{type:'text',text:'STAGING B'}]};
 assert.equal(snapshotRevision(a),snapshotRevision(JSON.parse(JSON.stringify(a))));assert.notEqual(snapshotRevision(a),snapshotRevision(b));assert.ok(Number.isSafeInteger(snapshotRevision(a)));
});
test('only a known 429 rejection can be reset for a retry; uncertain stays terminal',async()=>{
 const {createMessageExecutionStore}=require('../src/core/messageExecutions');let seen;
 const store=createMessageExecutionStore({query:async(sql,p)=>{seen={sql,p};return {rows:[]}}});
 await store.retryRejected(42);assert.match(seen.sql,/status='rejected'/);assert.match(seen.sql,/reason='line_rate_limited'/);assert.match(seen.sql,/status='pending'/);
});
