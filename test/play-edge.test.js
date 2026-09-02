const path=require('path');
const REPO=require('path').join(__dirname,'..');
const ejs=require(path.join(REPO,'node_modules/ejs'));
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.log('SKIP：需要 jsdom（npm i -D jsdom）'); process.exit(0); }
const PRIZES=[
 {id:11,name:'【26,000 哩】頭獎',position:1,probability_weight:5,is_grand_prize:true,description:'',image_url:null},
 {id:15,name:'Rice Dollar $30',position:2,probability_weight:400,is_grand_prize:false,description:'',image_url:null},
 {id:17,name:'銘謝惠顧',position:3,probability_weight:1000,is_grand_prize:false,prize_type:'none',description:'沒中獎時顯示這個',image_url:null}];
function fakeCtx(){const n=()=>{};return{canvas:{width:720,height:720},clearRect:n,beginPath:n,moveTo:n,closePath:n,fill:n,stroke:n,arc:n,lineTo:n,save:n,restore:n,translate:n,rotate:n,fillText:n,measureText:t=>({width:String(t).length*11}),set font(v){},get font(){return '';},fillStyle:'',strokeStyle:'',lineWidth:1,textAlign:'',textBaseline:'',globalAlpha:1,lineJoin:'',lineCap:'',setLineDash:n};}

async function boot(opts){
  const act={id:6,slug:'share-miles',name:'分享超有哩',description:'d',game_type:'wheel',status:'active',
    base_plays_per_user:1,referral_bonus_per:1,referral_invites_per_bonus:1,referral_bonus_max:2,start_at:null,end_at:null,rules:{}};
  const html=await ejs.renderFile(path.join(REPO,'views/game_wheel.ejs'),
    {title:'x',activity:act,prizes:PRIZES,liffId:'a-b',effectiveLiffId:'a-b',addFriendUrl:'',shareUrl:'',bodyClass:'',oaAddUrl:''},
    {views:[path.join(REPO,'views')]});
  const calls=[];
  let remaining=opts.remaining;
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://x/games/wheel/share-miles',beforeParse(w){
    w.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
    w.HTMLCanvasElement.prototype.getContext=()=>fakeCtx();
    w.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,isApiAvailable:()=>false,
            getIDToken:()=>'tok',login(){},getProfile:async()=>({userId:'U'+'a'.repeat(32),displayName:'測試員'}),
            shareTargetPicker:async()=>({})};
    w.fetch=(u,o)=>{
      calls.push(u);
      if(u.indexOf('/meta')>=0) return Promise.resolve({json:async()=>({ok:true,quota:{total:opts.total,played:opts.total-remaining,
        remaining:remaining,referrals:0,referrals_existing:0,base:1,referral_bonus:0,referral_bonus_max:2,
        referral_bonus_per:1,referral_invites_per_bonus:1,next_bonus_in:1,bonus_plays:0,override:null}})});
      if(u.indexOf('/spin')>=0){
        if(remaining<=0) return Promise.resolve({status:429,json:async()=>({ok:false,error:'quota_exhausted',
          detail:'次數已用完！邀請還沒加入官方帳號的朋友來玩可以再加 1 次。'})});
        remaining--;
        return Promise.resolve({json:async()=>({ok:true,prize:{id:17,name:'銘謝惠顧',description:'沒中獎時顯示這個',
          prize_type:'none',is_grand_prize:false,image_url:null},quota:{total:opts.total,played:opts.total-remaining,remaining:remaining}})});
      }
      if(u.indexOf('/wallet')>=0) return Promise.resolve({json:async()=>({ok:true,coupons:[],
        prizes:[{activity_slug:'share-miles',prize_name:'銘謝惠顧',is_win:false,miles:null,code:null,won_at:'2026-08-18T05:00:00Z',redeemed:false},
                {activity_slug:'share-miles',prize_name:'Rice Dollar $30',is_win:true,miles:null,code:null,won_at:'2026-08-18T04:00:00Z',redeemed:false}]})});
      return Promise.resolve({json:async()=>({ok:true})});
    };
  }});
  const w=dom.window;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r=>setTimeout(r,500));
  return {w,doc:w.document,calls};
}
const t=(doc,id)=>{const e=doc.getElementById(id);return e?e.textContent.replace(/\s+/g,' ').trim():'(無)';};

(async()=>{
  let bad=0;
  // A) 沒中獎的彈窗
  let {doc,calls}=await boot({total:3,remaining:3});
  const redeem=doc.getElementById('redeem-details');
  const terms=doc.querySelector('.terms-link');
  if(!redeem || redeem.open || t(doc,'redeem-details').indexOf('2026/12/9 前')<0){
    console.log('【兌獎說明】★ 收合狀態或重要期限不正確'); bad++;
  }
  if(!terms || terms.href!=='https://tw.openrice.com/info/event/202609-mgm/index.html'){
    console.log('【活動條款】★ 連結不正確'); bad++;
  }
  doc.getElementById('cta-spin').click();
  await new Promise(r=>setTimeout(r,2000));
  console.log('【沒中獎】彈窗標題:', t(doc,'modal-eyebrow'), '｜獎項:', t(doc,'modal-prize'), '｜說明:', t(doc,'modal-desc'));
  console.log('           主鈕:', t(doc,'modal-close')||t(doc,'modal-dismiss'));
  if(t(doc,'modal-desc').indexOf('沒中獎時顯示這個')>=0){ console.log('           ★ 後台備註文字外洩給用戶'); bad++; }
  console.log('【我的抽獎紀錄】', t(doc,'myprize').slice(0,90));
  if(doc.getElementById('myprize').hidden || t(doc,'myprize').indexOf('最新')<0){
    console.log('           ★ 抽完後結果沒有留在本頁'); bad++;
  }
  if(doc.getElementById('wallet-link')){
    console.log('           ★ 仍要使用者跳到另一頁找獎項'); bad++;
  }

  // B) 連點兩下只能送一次
  ({doc,calls}=await boot({total:3,remaining:3}));
  calls.length=0;
  doc.getElementById('cta-spin').click();
  doc.getElementById('cta-spin').click();
  doc.getElementById('cta-spin').click();
  await new Promise(r=>setTimeout(r,2000));
  const spins=calls.filter(u=>u.indexOf('/spin')>=0).length;
  console.log('\n【連點三下】實際送出抽獎請求:', spins, spins===1?'（正確，只送一次）':'★ 重複送出');
  if(spins!==1) bad++;

  // C) 次數用完
  ({doc,calls}=await boot({total:1,remaining:0}));
  console.log('\n【次數用完】狀態列:', t(doc,'status'), '｜主鈕文字:', t(doc,'cta-spin'));
  calls.length=0;
  doc.getElementById('cta-spin').click();
  await new Promise(r=>setTimeout(r,800));
  console.log('           按下主鈕後有沒有硬送抽獎:', calls.filter(u=>u.indexOf('/spin')>=0).length? '★ 有' : '沒有（正確，改成找朋友）');
  if(calls.filter(u=>u.indexOf('/spin')>=0).length) bad++;

  console.log(bad? ('\n發現 '+bad+' 個問題') : '\n邊界情況都正常');
  process.exit(bad?1:0);
})().catch(e=>{console.error('爆掉:',e&&e.stack||e);process.exit(2);});
