const path=require('path');
const REPO=require('path').join(__dirname,'..');
const ejs=require(path.join(REPO,'node_modules/ejs'));
const {JSDOM}=require('jsdom');
const U=n=>'U'+String(n).padStart(32,'0');
const DATA={ok:true,players:[
 {line_user_id:U(1),line_display_name:'林御恒 Hen',crm_display_name:'林御恒 Hen',plays:6,wins:1,grand_wins:0,
  last_played_at:'2026-08-18T03:54:00Z',referrals:0,referrals_existing:1,manual_bonus:0,
  max_plays_override:99,quota_note:null,quota_granted_by:null,quota_total:99,quota_remaining:93,
  invited_by_uid:null,invited_by_name:null,invited_was_existing:null},
 {line_user_id:U(2),line_display_name:'Ice Chen',crm_display_name:'Ice Chen',plays:1,wins:0,grand_wins:0,
  last_played_at:'2026-08-18T04:42:00Z',referrals:0,referrals_existing:1,manual_bonus:0,
  max_plays_override:null,quota_note:null,quota_granted_by:null,quota_total:1,quota_remaining:0,
  invited_by_uid:U(1),invited_by_name:'林御恒 Hen',invited_was_existing:true},
 {line_user_id:U(3),line_display_name:'小新',crm_display_name:'小新',plays:1,wins:1,grand_wins:1,
  last_played_at:'2026-08-18T05:00:00Z',referrals:2,referrals_existing:0,manual_bonus:1,
  max_plays_override:null,quota_note:null,quota_granted_by:null,quota_total:4,quota_remaining:3,
  invited_by_uid:U(2),invited_by_name:'Ice Chen',invited_was_existing:false}],
 stats:{players:3,plays:8,wins:2}};
(async()=>{
  const html=await ejs.renderFile(path.join(REPO,'views/admin_activity_players.ejs'),
    {title:'x',bodyClass:'admin-shell',user:'admin',isAdmin:true,activityId:6,
     activity:{name:'分享超有哩',slug:'share-miles',base_plays_per_user:1,referral_bonus_per:1,referral_bonus_max:2,game_type:'wheel',status:'active'}},
    {views:[path.join(REPO,'views')]});
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://x/admin/activities/6/players',beforeParse(w){
    w.fetch=()=>Promise.resolve({json:()=>Promise.resolve(DATA)});
    w.confirm=()=>true; w.URL.createObjectURL=()=>'blob:'; w.URL.revokeObjectURL=()=>{};
  }});
  const w=dom.window,doc=w.document;
  doc.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r=>setTimeout(r,200));
  const heads=[...doc.querySelectorAll('thead th')].map(t=>t.textContent.replace(/\s+/g,' ').trim());
  console.log('表頭:', heads.join(' ｜ '));
  console.log('');
  [...doc.querySelectorAll('#players-tbody tr')].forEach(tr=>{
    const c=[...tr.cells].map(t=>t.textContent.replace(/\s+/g,' ').trim());
    console.log(c.slice(0,6).join('  ｜  '));
  });
  const rows=doc.querySelectorAll('#players-tbody tr');
  const ok = rows.length===3 &&
    /林御恒 Hen/.test(rows[1].cells[1].textContent) &&
    /本來就是好友/.test(rows[1].cells[1].textContent) &&
    /自己來的/.test(rows[0].cells[1].textContent) &&
    rows[0].cells[2].textContent.indexOf('99')>=0 &&
    rows[0].cells[4].textContent.indexOf('93')>=0 &&
    rows[2].cells[2].textContent.indexOf('含人工補 1 次')>=0;
  console.log(ok?'\n結果：被誰邀請、總次數／已用／剩下都正確':'\n結果：有問題');
  process.exit(ok?0:1);
})().catch(e=>{console.error('爆掉:',e);process.exit(2);});
