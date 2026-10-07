const test=require('node:test');const assert=require('node:assert/strict');
const audience=require('../src/core/broadcastAudience');
test('exclusions retain failed test members and remove them before random selection',async()=>{
 const calls=[];const query=async(sql,params)=>{calls.push(sql);
 if(sql.includes('FROM admin_broadcasts'))return {rows:[{id:1,channel:'line',is_ab_test:true}]};
 if(sql.includes('FROM admin_broadcast_recipients'))return {rows:[{line_user_id:'STAGING_1'},{line_user_id:'STAGING_2'}]};
 return {rows:[{user_id:1,line_user_id:'STAGING_1'},{user_id:2,line_user_id:'STAGING_2'},{user_id:3,line_user_id:'STAGING_3'},{user_id:3,line_user_id:'STAGING_3'}]};};
 const p=await audience.previewAudience(query,{allMembers:true,excludeBroadcastIds:[1]});assert.equal(p.total,1);assert.equal(p.excludedTotal,2);
 const r=await audience.fetchAudienceRecipients(query,{allMembers:true,excludeBroadcastIds:[1]},{limit:1,randomize:true});assert.deepEqual(r.rows.map(x=>x.line_user_id),['STAGING_3']);
 assert.ok(calls.some(sql=>sql.includes("variant IN ('a', 'b', 'c')")&&!sql.includes("status = 'sent'")));
});
test('invalid or missing exclusion sources fail closed',async()=>{
 for(const id of ['1e2','-1','0','x',{},9007199254740992])await assert.rejects(()=>audience.previewAudience(async()=>({rows:[]}),{allMembers:true,excludeBroadcastIds:[id]}));
 await assert.rejects(()=>audience.previewAudience(async()=>({rows:[]}),{allMembers:true,excludeBroadcastIds:[1]}));
});
const {audienceRevision,signAudiencePreview,verifyAudiencePreview}=require('../src/core/broadcastAudienceExclusions');
test('signed audience previews reject same-sized changed pools, tampering and expiration',()=>{
 const base={revision:audienceRevision([{line_user_id:'STAGING_A'}]),conditions:{allMembers:true,excludeBroadcastIds:[1]},selection:{mode:'all',count:null}};
 const token=signAudiencePreview(base,'STAGING_TEST_SECRET',1000);
 assert.equal(verifyAudiencePreview(token,base,'STAGING_TEST_SECRET',2000),true);
 assert.equal(verifyAudiencePreview(token,{...base,revision:audienceRevision([{line_user_id:'STAGING_B'}])},'STAGING_TEST_SECRET',2000),false);
 assert.equal(verifyAudiencePreview(token+'x',base,'STAGING_TEST_SECRET',2000),false);
 assert.equal(verifyAudiencePreview(token,base,'STAGING_TEST_SECRET',601000),false);
});
