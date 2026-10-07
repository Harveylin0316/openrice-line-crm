const test=require('node:test');const assert=require('node:assert/strict');
test('follow classification never guesses unknown evidence as first-time friend',()=>{
 const {classifyFollow}=require('../src/core/welcomeMessages');
 assert.equal(classifyFollow({isUnblocked:true}),'unblocked');assert.equal(classifyFollow({isUnblocked:false,hadPriorFriendEvidence:false}),'first');
 assert.equal(classifyFollow({}),'unknown');assert.equal(classifyFollow({isUnblocked:false,hadPriorFriendEvidence:true}),'unknown');
});
test('welcome settings reject enabling without confirming duplicate flow check',async()=>{
 const {createWelcomeService}=require('../src/core/welcomeMessages');
 const s=createWelcomeService({pool:{connect(){throw new Error('must not connect')}},query(){},executionStore:{}});
 await assert.rejects(()=>s.save({enabled:true},'STAGING_ADMIN'),/duplicate_check_required/);
});
test('welcome library IDs reject coercible non-digit representations',async()=>{
 const {createWelcomeService}=require('../src/core/welcomeMessages');
 const service=createWelcomeService({pool:{connect:async()=>{throw new Error('should_not_open_transaction')}},query:()=>{},executionStore:{}});
 for(const messageId of ['1e2','0x10',1.5,{},-1])await assert.rejects(service.save({revision:1,messageId}),/message_id_invalid/);
});
