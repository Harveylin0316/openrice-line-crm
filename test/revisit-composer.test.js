'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const {validateTemplate,registerRevisitMailTemplates}=require('../src/routes/revisitMailTemplates');
const row={recipient_name:'測試客人',recipient_email:'qa@example.com',restaurant_name:'虛構餐廳'};
const value={name:'回訪',subject:'歡迎 {{餐廳名稱}}',preheader:'',body_text:'謝謝 {{客人姓名}}'};
function ui({editable=true,request=async()=>({templates:[]})}={}){
 const dom=new JSDOM('<div id="editor"><label>主旨<input id="rv-edit-subject" value="原主旨"></label><label>預覽<input id="rv-edit-preheader" value="預覽文字"></label><label>內文<textarea id="rv-edit-body">虛構餐廳歡迎測試客人</textarea></label><label>網址<input id="rv-edit-cta" value="https://example.com/book"></label><iframe class="rv-preview"></iframe></div>',{runScripts:'outside-only'});
 const w=dom.window;w.eval(fs.readFileSync('public/revisit-composer.js','utf8'));
 const root=w.document.querySelector('#editor');w.RevisitComposer.mount({root,row,editable,request});return {dom,w,root,doc:w.document};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('mail templates reject invalid/oversized fields and subject header injection without truncating',()=>{
 assert.deepEqual(validateTemplate(value),value);
 for(const input of [{...value,subject:'a\r\nBcc: x'},{...value,name:''},{...value,body_text:'x'.repeat(4001)},{...value,subject:'x'.repeat(201)},null])assert.throws(()=>validateTemplate(input));
});
test('templates route is authenticated, owner-only and parameterized; saves append-only without To/CTA',async()=>{
 const routes={},queries=[];const admin=()=>{},owner=()=>{};
 registerRevisitMailTemplates({get:(p,...h)=>routes.get=h,post:(p,...h)=>routes.post=h},{requireAdmin:admin,requireOwner:owner,query:async(s,p)=>{queries.push({s,p});return {rows:[{id:1,...value}]}}});
 assert.equal(routes.get[0],admin);assert.equal(routes.post[0],owner);
 const res={setHeader(){},status(n){this.code=n;return this},json(b){this.body=b;return this}};
 await routes.post[1]({body:{...value,recipient_email:'ignored@example.com',cta_url:'https://example.com'},authUser:{un:'QA'}},res);
 assert.equal(res.code,201);assert.match(queries[0].s,/INSERT INTO/);assert.equal(queries[0].p.length,5);assert.ok(!queries[0].s.includes('recipient_email'));assert.ok(!queries[0].p.includes('https://example.com'));
 await routes.get[1]({},res);assert.equal(res.body.templates[0].id,1);
});
test('DB errors never claim saved; invalid inputs never query',async()=>{
 let handler,calls=0;registerRevisitMailTemplates({get(){},post:(p,...h)=>handler=h[1]},{requireAdmin(){},requireOwner(){},query:async()=>{calls++;throw Error('secret connection error')}});
 const r={status(n){this.code=n;return this},json(b){this.body=b;return this}};
 await handler({body:{}},r);assert.equal(r.code,400);assert.equal(calls,0);
 await handler({body:value},r);assert.equal(r.code,503);assert.doesNotMatch(JSON.stringify(r.body),/secret/);
});
test('composer presents mail envelope and live plain-text preview, not unsupported rich HTML',()=>{
 const s=ui();assert.match(s.root.textContent,/sales@openrice.com.tw/);assert.match(s.root.textContent,/qa@example.com/);assert.equal(s.doc.querySelector('iframe').hidden,true);
 s.doc.querySelector('#rv-edit-body').value='<script>not executable</script>';s.doc.querySelector('#rv-edit-body').dispatchEvent(new s.w.Event('input'));
 assert.match(s.doc.querySelector('pre').textContent,/<script>/);assert.equal(s.doc.querySelector('pre script'),null);assert.match(s.doc.querySelector('pre').textContent,/取消訂閱/);s.dom.window.close();
});
test('apply needs explicit consent, expands restaurant/name, preserves CTA and does not save/send',async()=>{
 const calls=[];const s=ui({request:async(...args)=>{calls.push(args);return {templates:[{id:3,...value}]}}});await tick();
 s.doc.querySelector('select').value='3';s.doc.querySelector('[data-apply]').click();assert.equal(s.doc.querySelector('#rv-edit-subject').value,'原主旨');
 s.doc.querySelector('[data-replace]').checked=true;s.doc.querySelector('[data-apply]').click();
 assert.equal(s.doc.querySelector('#rv-edit-subject').value,'歡迎 虛構餐廳');assert.equal(s.doc.querySelector('#rv-edit-body').value,'謝謝 測試客人');assert.equal(s.doc.querySelector('#rv-edit-cta').value,'https://example.com/book');assert.equal(calls.length,1);s.dom.window.close();
});
test('save persists reusable names, excludes recipient/CTA, prevents rapid duplicate clicks',async()=>{
 const posts=[];let resolve;const s=ui({request:(url,data)=>data?new Promise(r=>{posts.push(data);resolve=r;}):Promise.resolve({templates:[]})});await tick();
 s.doc.querySelector('[aria-label="新範本名稱"]').value='我的範本';const b=s.doc.querySelector('[data-save]');b.click();b.click();assert.equal(posts.length,1);assert.equal(posts[0].body_text,'{{餐廳名稱}}歡迎{{客人姓名}}');assert.ok(!('cta_url' in posts[0]));resolve({template:{id:4,...posts[0]}});await tick();assert.equal(s.doc.querySelector('select').value,'4');assert.match(s.root.textContent,/已儲存新範本/);s.dom.window.close();
});
test('locked recipients have preview but no template mutation controls',()=>{const s=ui({editable:false});assert.equal(s.doc.querySelector('[data-apply]'),null);assert.ok(s.doc.querySelector('pre'));s.dom.window.close();});
test('late template responses cannot overwrite new editor; errors leave typed content intact',async()=>{
 let resolve;const s=ui({request:()=>new Promise(r=>resolve=r)});s.root.replaceChildren();resolve({templates:[value]});await tick();assert.equal(s.root.children.length,0);s.dom.window.close();
 const failed=ui({request:async()=>{throw Error('offline')}});await tick();assert.match(failed.root.textContent,/載入失敗/);assert.equal(failed.doc.querySelector('#rv-edit-subject').value,'原主旨');failed.dom.window.close();
});
test('late initial load preserves newly saved template and current selection',async()=>{
 let load;const s=ui({request:(url,data)=>data?Promise.resolve({template:{id:8,...data}}):new Promise(r=>load=r)});
 s.doc.querySelector('[aria-label="新範本名稱"]').value='新範本';s.doc.querySelector('[data-save]').click();await tick();assert.equal(s.doc.querySelector('select').value,'8');
 load({templates:[]});await tick();assert.equal(s.doc.querySelector('select').value,'8');assert.ok(s.doc.querySelector('option[value="8"]'));s.dom.window.close();
});
