const test=require('node:test');const assert=require('node:assert/strict');
const mod=require('../src/core/broadcastMessageSnapshot');
test('followup uses independent frozen B config and always excludes source test cohort',()=>{
 assert.equal(typeof mod.buildFollowupConfig,'function');
 const source={id:12,channel:'line',is_ab_test:true,audience_config:{conditions:{savedListId:7}},message_config:{mode:'sequence',items:[{type:'text',text:'A'}]},variant_b_message_config:{mode:'sequence',items:[{type:'text',text:'B https://example.com/?variant=b&utm_source=staging'}]}};
 const result=mod.buildFollowupConfig(source,'b');assert.equal(result.message_config.items[0].text,source.variant_b_message_config.items[0].text);assert.deepEqual(result.conditions.excludeBroadcastIds,[12]);
 result.message_config.items[0].text='changed';assert.notEqual(source.variant_b_message_config.items[0].text,'changed');
 assert.throws(()=>mod.buildFollowupConfig(source,'c'));assert.throws(()=>mod.buildFollowupConfig({...source,channel:'email'},'b'));
});
