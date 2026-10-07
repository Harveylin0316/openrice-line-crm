const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core/campaignExperiment');
const valid = {enabled:true,variant_count:2,observation_hours:24,metric:'ctr',allocations:{a:30,b:30,c:0,holdout:40}};
test('new campaigns default manual and reject invalid release modes',()=>{
 assert.equal(core.normalizeCampaignExperiment(valid).value.winnerMode,'manual');
 assert.equal(core.normalizeCampaignExperiment({...valid,winner_mode:'auto'}).value.winnerMode,'auto');
 assert.equal(core.normalizeCampaignExperiment({...valid,winner_mode:'other'}).ok,false);
});
test('release requires a valid completed observation window',()=>{
 const now=new Date('2026-10-05T02:00:00Z');
 for(const winnerAt of [null,'invalid','2026-10-06T02:00:00Z']) assert.equal(core.canReleaseExperiment({winnerAt},now).ok,false);
 assert.equal(core.canReleaseExperiment({winnerAt:'2026-10-05T02:00:00Z'},now).ok,true);
});
test('campaign comparison stops at missing delivery, zero clicks and equal rates',()=>{
 const rows=(a,b,c=10,d=10)=>[{variant:'a',sent_ok:c,clickers:a},{variant:'b',sent_ok:d,clickers:b}];
 assert.equal(core.resolveCampaignWinner(rows(0,0),['a','b']).reason,'no_clicks');
 assert.equal(core.resolveCampaignWinner(rows(1,2,10,20),['a','b']).reason,'tie');
 assert.equal(core.resolveCampaignWinner(rows(0,2,0,20),['a','b']).reason,'insufficient_delivery');
 assert.equal(core.resolveCampaignWinner(rows(1,2),['a','b']).winner,'b');
 assert.equal(core.resolveCampaignWinner(rows(1,2),['a','b','c']).winner,null);
});
const {registerAdminBroadcastRoutes}=require('../src/routes/adminBroadcast');
function releaseHarness({deadline='2020-01-01T00:00:00Z',mode='manual',stats=[{variant:'a',sent_ok:10,clickers:1},{variant:'b',sent_ok:10,clickers:2}]}={}) {
 const routes={},calls=[]; let released=false;
 const source={id:1,status:'awaiting_winner',channel:'line',message_config:{mode:'template',template:{title:'STAGING A'}},variant_b_message_config:{mode:'template',template:{title:'STAGING B'}},audience_config:{experiment:{enabled:true,variantCount:2,winnerAt:deadline,winnerMode:mode}}};
 const client={release(){},async query(sql,params){calls.push({sql,params});
 if(sql.includes('SELECT * FROM admin_broadcasts'))return {rows:[source],rowCount:1};
 if(sql.includes('SELECT r.variant'))return {rows:stats};
 if(sql.includes('SELECT user_id, line_user_id, email'))return {rows:[{user_id:1,line_user_id:'STAGING_SYNTHETIC_RECIPIENT'}]};
 if(sql.includes('INSERT INTO admin_broadcasts')) {released=true;return {rows:[{id:2}]};}
 if(sql.includes("SET status = 'winner_released'")){source.status='winner_released';source.audience_config=JSON.parse(params[1]);}
 if(sql.startsWith('UPDATE admin_broadcasts SET audience_config'))source.audience_config=JSON.parse(params[1]);
 return {rows:[],rowCount:0};}};
 registerAdminBroadcastRoutes({get(){},post(p,...h){routes[p]=h.at(-1)},delete(){},put(){}},{query:client.query,pool:{connect:async()=>client},authCore:{requireAdmin(){}},linePush:{},emailProvider:{isConfigured:()=>false},lineChannelAccessToken:'STAGING_MOCK'});
 const handler=routes[Object.keys(routes).find(k=>k.endsWith('/release-experiment-winner'))];
 async function run(choice='b'){const res={statusCode:200,status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};await handler({params:{id:1},body:{winner_variant:choice},authUser:{un:'STAGING_REVIEWER'}},res);return res;}
 return {run,calls,source,get released(){return released}};
}
test('release API refuses premature release without inserting a batch',async()=>{
 const h=releaseHarness({deadline:'2099-01-01T00:00:00Z'});const r=await h.run();assert.equal(r.body.ok,false);assert.equal(h.released,false);
});
test('manual release freezes selected B snapshot, records review and is idempotent',async()=>{
 const h=releaseHarness();const r=await h.run();assert.equal(r.body.broadcastId,2);
 const insert=h.calls.find(c=>c.sql.includes('INSERT INTO admin_broadcasts'));
 assert.equal(JSON.parse(insert.params[2]).template.title,'STAGING B');
 assert.equal(h.source.audience_config.experiment.selectionMethod,'manual');
 assert.equal(h.source.audience_config.experiment.selectedBy,'STAGING_REVIEWER');
 assert.equal((await h.run()).body.alreadyReleased,true);
 assert.equal(h.calls.filter(c=>c.sql.includes('INSERT INTO admin_broadcasts')).length,1);
});
test('auto zero-click release pauses instead of selecting A',async()=>{
 const h=releaseHarness({mode:'auto',stats:[{variant:'a',sent_ok:10,clickers:0},{variant:'b',sent_ok:10,clickers:0}]});
 assert.equal((await h.run('auto')).body.awaitingApproval,true);assert.equal(h.released,false);assert.equal(h.source.audience_config.experiment.winnerMode,'manual');
});
