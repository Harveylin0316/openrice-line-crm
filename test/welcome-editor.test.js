const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup({ deleted = false, preview, loadError = false } = {}) {
 const html = await ejs.renderFile(path.join(__dirname, '../views/admin_welcome_messages.ejs'), {user:'qa', isAdmin:true});
 const dom = new JSDOM(html, {url:'https://crm.example/admin/welcome-messages', runScripts:'outside-only'});
 const w = dom.window, calls = [];
 const saved = {revision:3, enabled:false, first_enabled:true, unblocked_enabled:false, message_id:1, message_name:'Saved <img src=x>', message_snapshot:{mode:'text',text:'Saved'}};
 w.fetch = async (url, options) => {
  const body = options?.body && JSON.parse(options.body); calls.push({url,body});
  let data;
  if(url.endsWith('/api/list')) data={ok:true,messages:[...(!deleted?[{id:1,name:'Live',channel:'line',message_config:{mode:'text'}}]:[]),{id:2,name:'Map',channel:'line',message_config:{mode:'imagemap'}},{id:'2x',name:'Invalid',channel:'line'},{id:3,name:'Email',channel:'email'}]};
  else if(url.endsWith('/preview')) data=preview?await preview(body):{ok:true,messages:[{type:'text',text:body.saved?'Saved preview':'New preview'}]};
  else if(body) data={ok:true,settings:{...saved,revision:4,message_id:Number(body.messageId),enabled:body.enabled,first_enabled:body.firstEnabled,unblocked_enabled:body.unblockedEnabled}};
  else data=loadError?{ok:false,error:'migration_required'}:{ok:true,settings:saved,flows:[],testers:[]};
  return {ok:true,json:async()=>data};
 };
 w.confirm=()=>true;
 w.eval(fs.readFileSync(path.join(__dirname,'../public/message-snapshot-preview.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(__dirname,'../public/admin-welcome-messages.js'),'utf8'));
 for (const script of w.document.querySelectorAll('script:not([src])')) w.eval(script.textContent);
 await tick();await tick();
 return {w,calls,$:id=>w.document.getElementById(id),change(id,value){const el=w.document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));},close:()=>w.close()};
}
test('saved snapshot previews automatically without saving or refreshing library content',async()=>{
 const c=await setup();try {assert.match(c.$('welcome-preview-content').textContent,/Saved preview/);assert.equal(c.calls.filter(x=>x.url.endsWith('/api')&&x.body).length,0);assert.equal(c.$('welcome-test').disabled,true);assert.equal(c.$('welcome-save').disabled,true);}finally{c.close();}
});
test('selection previews new asset; cancellation restores snapshot, order and flags',async()=>{
 const c=await setup();try {c.change('welcome-message','2');c.change('welcome-unblocked',true);await tick();assert.match(c.$('welcome-preview-content').textContent,/New preview/);assert.equal(c.$('welcome-save').disabled,false);c.$('welcome-cancel').click();await tick();assert.equal(c.$('welcome-message').value,'1');assert.equal(c.$('welcome-unblocked').checked,false);assert.match(c.$('welcome-preview-content').textContent,/Saved preview/);assert.equal(c.$('welcome-save').disabled,true);}finally{c.close();}
});
test('explicit refresh submits revision and refresh flag; enabled saves require duplicate confirmation',async()=>{
 const c=await setup();try {c.$('welcome-refresh').click();c.change('welcome-enabled',true);c.$('welcome-form').dispatchEvent(new c.w.Event('submit',{cancelable:true}));await tick();assert.equal(c.calls.filter(x=>x.url.endsWith('/api')&&x.body).length,0);c.change('welcome-duplicate',true);c.$('welcome-form').dispatchEvent(new c.w.Event('submit',{cancelable:true}));await tick();assert.deepEqual(c.calls.find(x=>x.url.endsWith('/api')&&x.body).body,{revision:3,enabled:true,firstEnabled:true,unblockedEnabled:false,messageId:'1',refreshSnapshot:true,duplicateCheckConfirmed:true});assert.equal(c.$('welcome-save').disabled,true);}finally{c.close();}
});
test('deleted original remains safe frozen selection; malformed and email IDs are excluded',async()=>{
 const c=await setup({deleted:true});try {assert.equal(c.$('welcome-message').value,'1');assert.equal(c.$('welcome-refresh').disabled,true);assert.equal(c.$('welcome-message').querySelector('img'),null);assert.deepEqual([...c.$('welcome-message').options].map(o=>o.value),['','2','1']);assert.match(c.$('welcome-preview-content').textContent,/Saved preview/);}finally{c.close();}
});
test('late preview error cannot replace current selected preview',async()=>{
 let reject;const c=await setup({preview:body=>body.saved?new Promise((_,r)=>{reject=r}):Promise.resolve({ok:true,messages:[{type:'text',text:'New preview'}]})});try {c.change('welcome-message','2');await tick();reject(new Error('old failure'));await tick();assert.match(c.$('welcome-preview-content').textContent,/New preview/);assert.doesNotMatch(c.$('welcome-status').textContent,/old failure/);}finally{c.close();}
});
test('load error keeps editor disabled and welcome navigation belongs to messages',async()=>{
 const c=await setup({loadError:true});try {assert.equal(c.$('welcome-fields').disabled,true);assert.match(c.$('welcome-status').textContent,/migration/);assert.equal(c.w.document.querySelector('[data-admin-section="message"]').classList.contains('has-active'),true);assert.equal(c.w.document.querySelector('[data-category="設定"] a[href="/admin/welcome-messages"]'),null);}finally{c.close();}
});
