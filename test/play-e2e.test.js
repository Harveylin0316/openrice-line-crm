// 把真正的轉盤頁跑起來，連轉多次，用「畫布上實際畫了什麼」去驗證指針對不對。
const path=require('path');
const REPO=require('path').join(__dirname,'..');
const ejs=require(path.join(REPO,'node_modules/ejs'));
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.log('SKIP：需要 jsdom（npm i -D jsdom）'); process.exit(0); }

const PRIZES=[
 {id:11,name:'【26,000 哩】頭獎',position:1,probability_weight:5,is_grand_prize:true,description:'',image_url:null},
 {id:12,name:'【15,000 哩】二獎',position:2,probability_weight:15,is_grand_prize:false,description:'',image_url:null},
 {id:13,name:'【10,000 哩】三獎',position:3,probability_weight:30,is_grand_prize:false,description:'',image_url:null},
 {id:14,name:'【5,000 哩】肆獎',position:4,probability_weight:100,is_grand_prize:false,description:'',image_url:null},
 {id:15,name:'Rice Dollar $30',position:5,probability_weight:400,is_grand_prize:false,description:'',image_url:null},
 {id:16,name:'Rice Dollar $100',position:6,probability_weight:230,is_grand_prize:false,description:'',image_url:null},
 {id:17,name:'銘謝惠顧',position:7,probability_weight:1000,is_grand_prize:false,prize_type:'none',description:'',image_url:null}];

function fakeCtx(rec){
  const noop=()=>{};
  return {
    canvas:{width:720,height:720},
    clearRect:noop, beginPath(){rec.cur={};}, moveTo:noop, closePath:noop, fill(){rec.fills.push({...rec.cur,fillStyle:this.fillStyle});},
    stroke(){rec.strokes.push({...rec.cur,strokeStyle:this.strokeStyle,lineWidth:this.lineWidth});},
    arc(x,y,r,a0,a1){rec.cur={x,y,r,a0,a1};},
    lineTo:noop, save:noop, restore:noop, translate:noop, rotate:noop, scale:noop,
    fillText(t,x,y){rec.texts.push({t,x,y,fillStyle:this.fillStyle});},
    measureText(t){return {width:String(t).length*11};},
    set font(v){this._f=v;} , get font(){return this._f;},
    fillStyle:'#000', strokeStyle:'#000', lineWidth:1, textAlign:'left', textBaseline:'top',
    globalAlpha:1, lineJoin:'round', lineCap:'round', setLineDash:noop, createLinearGradient:()=>({addColorStop:noop})
  };
}

(async()=>{
  const act={id:6,slug:'share-miles',name:'分享超有哩',description:'d',game_type:'wheel',status:'active',
    base_plays_per_user:1,referral_bonus_per:1,referral_invites_per_bonus:1,referral_bonus_max:2,
    start_at:null,end_at:null,rules:{}};
  const html=await ejs.renderFile(path.join(REPO,'views/game_wheel.ejs'),
    {title:'x',activity:act,prizes:PRIZES,liffId:'2007974193-3AWiL11Y',effectiveLiffId:'2007974193-3AWiL11Y',
     addFriendUrl:'',shareUrl:'',bodyClass:'',oaAddUrl:''},{views:[path.join(REPO,'views')]});

  const rec={fills:[],strokes:[],texts:[],cur:{}};
  let remaining=7, spinCount=0;
  const wantSeq=[4,0,6,2,5,1,3];   // 伺服器每次回傳哪一格（index）
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://openrice-line-crm.netlify.app/games/wheel/share-miles',
    beforeParse(w){
      w.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
      w.HTMLCanvasElement.prototype.getContext=()=>fakeCtx(rec);
      w.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,isApiAvailable:()=>false,
              getIDToken:()=>'tok',login(){},getProfile:async()=>({userId:'U'+'a'.repeat(32),displayName:'測試員'}),
              shareTargetPicker:async()=>({})};
      w.fetch=(u,o)=>{
        if(u.indexOf('/meta')>=0) return Promise.resolve({json:async()=>({ok:true,
          quota:{total:7,played:7-remaining,remaining:remaining,referrals:0,referrals_existing:0,base:1,
                 referral_bonus:0,referral_bonus_max:2,referral_bonus_per:1,referral_invites_per_bonus:1,
                 next_bonus_in:1,bonus_plays:0,override:null}})});
        if(u.indexOf('/spin')>=0){
          const idx=wantSeq[spinCount%wantSeq.length]; spinCount++; remaining--;
          const p=PRIZES[idx];
          return Promise.resolve({json:async()=>({ok:true,prize:{id:p.id,name:p.name,description:'',
            prize_type:p.prize_type||'badge',is_grand_prize:p.is_grand_prize,image_url:null},
            quota:{total:7,played:7-remaining,remaining:remaining}})});
        }
        if(u.indexOf('/wallet')>=0) return Promise.resolve({json:async()=>({ok:true,coupons:[],prizes:[]})});
        return Promise.resolve({json:async()=>({ok:true})});
      };
    }});
  const w=dom.window, doc=w.document;
  doc.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r=>setTimeout(r,600));
  console.log('開場狀態:', doc.getElementById('status').textContent.trim(), '｜剩餘顯示:', doc.getElementById('stat-remaining').textContent);

  const TAU=Math.PI*2;
  const norm=a=>((a%TAU)+TAU)%TAU;
  const POINTER=norm(-Math.PI/2);   // 正上方
  let bad=0;
  for(let k=0;k<wantSeq.length;k++){
    const wantIdx=wantSeq[k];
    rec.fills.length=0; rec.strokes.length=0; rec.texts.length=0;
    doc.getElementById('cta-spin').click();
    await new Promise(r=>setTimeout(r,2200));   // REDUCED 模式 1200ms + 緩衝
    // 找出高亮那圈（lineWidth 10、金色）
    const hi=rec.strokes.filter(s=>s.lineWidth===10&&String(s.strokeStyle).toUpperCase()==='#F9C73B').pop();
    const modal=doc.getElementById('modal-prize').textContent.trim();
    if(!hi){ console.log('第'+(k+1)+'轉：找不到高亮，跳過'); bad++; continue; }
    const a0=norm(hi.a0), a1=norm(hi.a1);
    const inside = a0<=a1 ? (POINTER>=a0-1e-9 && POINTER<=a1+1e-9)
                          : (POINTER>=a0-1e-9 || POINTER<=a1+1e-9);
    const ok = inside && modal===PRIZES[wantIdx].name.replace(/^【(.+?)】\s*/,'$1 ').trim().length>0;
    const modalOk = modal.indexOf(PRIZES[wantIdx].name.replace(/[【】]/g,'').split(' ')[0])>=0 ||
                    modal===PRIZES[wantIdx].name;
    if(!inside || !modalOk) bad++;
    console.log('第'+(k+1)+'轉  伺服器給「'+PRIZES[wantIdx].name+'」｜彈窗顯示「'+modal+'」｜指針落在高亮格內:'+(inside?'是':'否 ★'));
    // 關掉彈窗
    const dis=doc.getElementById('modal-dismiss'); if(dis) dis.click();
    await new Promise(r=>setTimeout(r,150));
  }
  console.log(bad? ('\n有 '+bad+' 轉不一致') : '\n連轉七次，指針與中獎結果每次都一致');
  process.exit(bad?1:0);
})().catch(e=>{console.error('爆掉:',e && e.stack || e);process.exit(2);});
