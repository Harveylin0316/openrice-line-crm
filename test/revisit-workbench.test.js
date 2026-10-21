'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ejs=require('ejs');
const {JSDOM}=require('jsdom');
const path=require('node:path');
const asset=n=>fs.readFileSync(path.join(__dirname,'../public',n),'utf8');
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const fixture=()=>[1,2,3,4].map(id=>({id,recipient_name:'測試客人'+id,recipient_email:'qa'+id+'@example.com',restaurant_name:'測試餐廳'+id,subject:'回訪'+id,preheader:'',body_copy:'謝謝來用餐',cta_url:'https://example.com/book/'+id,status:id===1?'needs_review':id===4?'sent':'pending',failure_detail:id===1?'outlook_draft_requested':null}));
async function ui({owner=true,failData=false}={}){
 const rendered=await ejs.renderFile(path.join(__dirname,'../views/admin_revisit_email.ejs'),{user:'Synthetic QA',isAdmin:true,isOwner:owner,bodyClass:'admin-shell revisit-email-shell'});
 const dom=new JSDOM(rendered,{runScripts:'outside-only',url:'https://crm.example.com/admin/revisit-email'}),w=dom.window,doc=w.document,calls=[];
 const rows=fixture(),campaign={id:1,status:'draft',settings_snapshot:{},excluded_counts:{}};
 let fail=failData;
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.fetch=async(url,opts)=>{
  calls.push({url,opts});let result;
  if(url.endsWith('/api/data')){if(fail)throw Error('offline');result={ok:true,settings:{},stats:{bookings:100,sent:1},booking_source:{id:1,accepted_count:100,source_file:'虛構名單'},sender:{},booking_report:{configured:true,status_available:true,latest_booking_date:'2026-10-21'},campaigns:[{...campaign,pending:2,needs_review:1,sent:1}],imports:[],suppressions:[]};}
  else if(url.endsWith('/campaigns/1'))result={ok:true,campaign,recipients:rows};
  else if(url.endsWith('/templates'))result={ok:true,templates:[]};
  else if(url.endsWith('/outlook-draft')){const r=rows.find(r=>url.includes('/'+r.id+'/'));r.status='needs_review';r.failure_detail='outlook_draft_requested';campaign.status='sending';result={ok:true,draft:{email:r.recipient_email,subject:r.subject,body:'完整內文含取消訂閱 https://example.com/unsubscribe',mailto:'mailto:qa@example.com?subject=test'}};}
  else throw Error('Unexpected request '+url);
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};
 };
 for(const f of ['crm-confirm.js','revisit-offer-import.js','revisit-composer.js','revisit-outlook.js','revisit-workbench.js'])w.eval(asset(f));
 const scripts=[...doc.querySelectorAll('script:not([src])')];
 w.eval(scripts.find(x=>x.textContent.includes('var IS_OWNER=')).textContent);
 await tick();
 return {dom,w,doc,rows,campaign,calls,setFail:v=>fail=v};
}
test('workbench keeps unknown/failed states separate, filters safely and never treats reserved drafts as sent',()=>{
 const d=new JSDOM('',{runScripts:'outside-only'});d.window.eval(asset('revisit-workbench.js'));const h=d.window.RevisitWorkbench;
 const rows=fixture();assert.equal(h.summarize(rows).review,1);assert.equal(h.summarize(rows).sent,1);assert.equal(h.filter(rows,'pending','QA2@EXAMPLE.COM').length,1);assert.equal(h.filter(rows,'pending','不存在').length,0);assert.equal(h.next(rows,1).id,2);assert.equal(h.next([{id:1,status:'sent'}],1),null);assert.match(h.label(rows[0]),/待核對/);d.window.close();
});
test('real EJS workbench resumes uncertain item, filters without erasing editor, and protects unsaved edits',async()=>{
 const s=await ui();s.doc.querySelector('#rv-next-action button').click();await tick();
 assert.match(s.doc.querySelector('#rv-editor').textContent,/qa1@example.com/);
 const filter=[...s.doc.querySelectorAll('[data-filters] button')].find(b=>b.textContent.startsWith('待處理'));filter.click();
 s.doc.querySelector('[data-open="2"]').click();await tick();
 const body=s.doc.querySelector('#rv-edit-body');body.value='未儲存修改';body.dispatchEvent(new s.w.Event('input',{bubbles:true}));
 const search=s.doc.querySelector('#rv-worklist input');search.value='餐廳3';search.dispatchEvent(new s.w.Event('input'));
 assert.equal(s.doc.querySelector('#rv-edit-body').value,'未儲存修改');assert.equal(s.doc.querySelectorAll('[data-open]').length,1);
 s.doc.querySelector('[data-next-recipient]').click();assert.equal(s.doc.querySelector('#rv-edit-body').value,'未儲存修改');assert.match(s.doc.querySelector('#rv-editor-msg').textContent,/未儲存/);
 s.doc.querySelector('#rv-close-review').click();assert.equal(s.doc.querySelector('#rv-review').hidden,false);
 s.doc.querySelector('#rv-next-action button').click();await tick();assert.equal(s.doc.querySelector('#rv-edit-body').value,'未儲存修改');s.dom.window.close();
});
test('reserving a draft preserves its fields and mailto, locks repeat preparation and offers safe copy fallback',async()=>{
 const s=await ui();s.doc.querySelector('#rv-next-action button').click();await tick();s.doc.querySelector('[data-open="2"]').click();
 s.doc.querySelector('.rv-outlook-actions input').checked=true;s.doc.querySelector('[data-outlook-open]').click();await tick();
 assert.equal(s.calls.filter(c=>c.url.endsWith('/outlook-draft')).length,1);
 assert.ok(s.doc.querySelector('a[href^="mailto:"]'));assert.equal(s.doc.querySelectorAll('[data-outlook-result] textarea').length,3);
 assert.equal(s.doc.querySelector('[data-outlook-open]').disabled,true);assert.equal(s.doc.querySelector('#rv-edit-body').disabled,true);
 s.doc.querySelector('[data-outlook-open]').click();assert.equal(s.calls.filter(c=>c.url.endsWith('/outlook-draft')).length,1);
 s.doc.querySelector('[data-outlook-result] button').click();await tick();assert.match(s.doc.querySelector('[data-outlook-msg]').textContent,/已選取完整欄位/);
 assert.match(s.doc.querySelector('#rv-batch-progress').textContent,/待核對 2/);s.dom.window.close();
});
test('failed data load does not display false zero/success and provides retry with restored permissions',async()=>{
 const s=await ui({failData:true});assert.match(s.doc.querySelector('#rv-next-action').textContent,/載入失敗/);assert.equal(s.doc.querySelector('#rv-kpis strong').textContent,'—');assert.equal(s.doc.querySelector('#rv-generate').disabled,true);
 s.setFail(false);s.doc.querySelector('#rv-next-action button').click();await tick();assert.match(s.doc.querySelector('#rv-next-action').textContent,/先核對/);assert.equal(s.doc.querySelector('#rv-generate').disabled,false);assert.equal(s.doc.querySelector('#rv-save-settings').disabled,false);s.dom.window.close();
});
test('read-only staff can inspect work without draft preparation or mutations',async()=>{
 const s=await ui({owner:false});s.doc.querySelector('#rv-next-action button').click();await tick();assert.equal(s.doc.querySelector('[data-outlook-open]'),null);assert.equal(s.doc.querySelector('#rv-save-copy'),null);assert.equal(s.doc.querySelector('#rv-generate').disabled,true);assert.match(s.doc.querySelector('#rv-sender').textContent,/唯讀/);s.dom.window.close();
});
