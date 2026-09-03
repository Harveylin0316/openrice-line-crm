const REPO=require('path').join(__dirname,'..');
const eng=require(REPO+'/src/core/gamePlayEngine.js');

// 假資料庫：同一份狀態同時餵給「玩的關卡」與「畫面顯示」
function makeDb(st){
  const handle = async (sql, params) => {
    const f = String(sql).replace(/\s+/g,' ');
    if (/FROM activities WHERE slug/.test(f)) return {rows:[{
      id:6,status:'active',start_at:null,end_at:null,
      daily_plays_per_user:st.daily==null?null:st.daily,
      base_plays_per_user:st.base, referral_bonus_per:st.per,
      referral_bonus_max:st.max, referral_invites_per_bonus:st.invitesPer}]};
    if (/activity_user_quotas/.test(f))
      return {rows: st.override==null?[]:[{max_plays_override:st.override,note:'t'}]};
    if (/COUNT\(\*\) AS c FROM activity_plays/.test(f)) {
      const drawExcluded = /draw_win/.test(f);
      const today = /date_trunc/.test(f);
      let n = st.played + (drawExcluded ? 0 : st.drawWins);
      if (today) n = st.playedToday + (drawExcluded ? 0 : st.drawWins);
      return {rows:[{c:n}]};
    }
    if (/FROM activity_referrals/.test(f)) {
      if (/FILTER/.test(f)) return {rows:[{c:st.newFriends, existing:st.oldFriends}]};
      return {rows:[{c:st.newFriends+st.oldFriends}]};   // 沒過濾的舊寫法會拿到這個
    }
    if (/activity_bonus_plays/.test(f)) return {rows:[{b:st.manualBonus}]};
    if (/FROM activity_prizes/.test(f)) return {rows:[{id:1,name:'獎',description:'',probability_weight:1,
      stock_total:null,stock_remaining:null,prize_type:'badge',prize_value:{},image_url:null,is_grand_prize:false,position:1}]};
    if (/INSERT INTO activity_plays/.test(f)) return {rows:[{id:99,played_at:new Date().toISOString()}]};
    if (/UPDATE activity_prizes/.test(f)) return {rows:[]};
    if (/coupon_codes/.test(f)) return {rows:[]};
    return {rows:[]};
  };
  const client={query:handle, release(){}};
  return {pool:{connect:async()=>client}, query:handle};
}

const CASES=[
 {n:'只有基本次數',                 base:1,per:1,max:2,invitesPer:1,newFriends:0,oldFriends:0,manualBonus:0,override:null,played:0,drawWins:0, want:1},
 {n:'3 位都是既有好友（防洗）',      base:1,per:1,max:2,invitesPer:1,newFriends:0,oldFriends:3,manualBonus:0,override:null,played:0,drawWins:0, want:1},
 {n:'2 位新朋友（上限 2）',          base:1,per:1,max:2,invitesPer:1,newFriends:2,oldFriends:0,manualBonus:0,override:null,played:0,drawWins:0, want:3},
 {n:'5 位新朋友（碰上限）',          base:1,per:1,max:2,invitesPer:1,newFriends:5,oldFriends:0,manualBonus:0,override:null,played:0,drawWins:0, want:3},
 {n:'每 2 位換 1 次，邀到 3 位',     base:1,per:1,max:5,invitesPer:2,newFriends:3,oldFriends:0,manualBonus:0,override:null,played:0,drawWins:0, want:2},
 {n:'人工補 2 次',                   base:1,per:1,max:2,invitesPer:1,newFriends:0,oldFriends:0,manualBonus:2,override:null,played:0,drawWins:0, want:3},
 {n:'個別配額 5 ＋ 人工補 2',        base:1,per:1,max:2,invitesPer:1,newFriends:0,oldFriends:0,manualBonus:2,override:5,   played:0,drawWins:0, want:7},
 {n:'被後台抽中大獎（不該扣次數）',   base:1,per:1,max:2,invitesPer:1,newFriends:0,oldFriends:0,manualBonus:0,override:null,played:0,drawWins:1, want:1},
];

(async()=>{
  let bad=0;
  for(const c of CASES){
    const st={daily:null,playedToday:0,...c};
    const db=makeDb(st);
    const q=await eng.computeUserQuota(db.query,{id:6,base_plays_per_user:c.base,referral_bonus_per:c.per,
      referral_bonus_max:c.max,referral_invites_per_bonus:c.invitesPer},'U1');
    // 玩的關卡：把已玩次數設成「剛好等於期望總數」，應該要被擋；設成少一次，應該要放行
    const blocked=await eng.selectPrizeAndRecord({pool:makeDb({...st,played:c.want}).pool,
      activitySlug:'x',gameType:'wheel',lineUserId:'U1',lineDisplayName:'t',req:{headers:{}}});
    const allowed=await eng.selectPrizeAndRecord({pool:makeDb({...st,played:Math.max(0,c.want-1)}).pool,
      activitySlug:'x',gameType:'wheel',lineUserId:'U1',lineDisplayName:'t',req:{headers:{}}});
    const gateTotal=(blocked.error&&blocked.error.quota&&blocked.error.quota.total);
    const ok = q.total===c.want && gateTotal===c.want && !!blocked.error && !allowed.error;
    if(!ok) bad++;
    console.log((ok?'OK  ':'錯！') + c.n);
    console.log('     顯示總次數 ' + q.total + ' ／ 關卡總次數 ' + gateTotal + ' ／ 應為 ' + c.want +
                ' ｜ 用滿時擋下:' + (blocked.error?'是':'否') + ' ｜ 差一次時放行:' + (allowed.error?'否（錯）':'是'));
  }
  console.log(bad? ('\n有 '+bad+' 個情境不一致') : '\n八個情境全部一致：顯示與實際完全相同');
  process.exit(bad?1:0);
})().catch(e=>{console.error('爆掉:',e);process.exit(2);});
