const REPO=require('path').join(__dirname,'..');
const Module=require('module'), orig=Module.prototype.require;
const pushed=[];
Module.prototype.require=function(id){
  if(id==='./linePush'||id.endsWith('/linePush')) return {createLinePushService:()=>({pushLineMessages:async(uid,msgs)=>{pushed.push({uid,text:(typeof msgs[0]==='string')?msgs[0]:(msgs[0]&&msgs[0].text)});return true;}})};
  if(id==='./oaFollower'||id.endsWith('/oaFollower')) return {fetchOaProfile:async()=>({displayName:'Ice Chen'})};
  return orig.apply(this,arguments);
};
const eng=require(REPO+'/src/core/gamePlayEngine.js');
const ACT={id:6,referral_bonus_per:1,referral_invites_per_bonus:1,referral_bonus_max:2,liff_id_override:null};
process.env.GAMES_LIFF_ID='2007974193-3AWiL11Y';

function q(newFriendCount){
  return async(sql)=>{
    const f=sql.replace(/\s+/g,' ');
    if(/COUNT\(\*\) AS c FROM activity_referrals/.test(f)){
      if(!/invitee_was_existing IS FALSE/.test(f)) throw new Error('計數沒有過濾既有好友');
      return {rows:[{c:newFriendCount}]};
    }
    return {rows:[]};
  };
}
(async()=>{
  const cases=[
    {label:'對方本來就是好友（Ice 的情況）', existing:true,  count:0},
    {label:'真的新朋友，第 1 位',            existing:false, count:1},
    {label:'真的新朋友，第 3 位（已達上限）', existing:false, count:3},
  ];
  for(let i=0;i<cases.length;i++){ const c=cases[i];
    pushed.length=0;
    await eng.notifyInviterOfReferral({query:q(c.count),activity:ACT,activitySlug:'share-miles',
      gameType:'wheel',inviterId:'U'+String(i).repeat(32).slice(0,32),inviteeId:'U'+'b'.repeat(32),
      inviteeWasExisting:c.existing});
    console.log('【'+c.label+'】');
    console.log('  ' + (pushed[0]?pushed[0].text:'(沒推播)'));
    console.log('');
  }
  const okText = true;
  process.exit(0);
})().catch(e=>{console.error('爆掉:',e.message);process.exit(1);});
