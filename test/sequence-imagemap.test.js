const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { buildLineMessages, validateMessageConfig } = require('../src/core/broadcastTemplates');
const im = { mode:'imagemap', imagemap:{assetId:'9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b',baseWidth:1040,baseHeight:780,altText:'STAGING',areas:[{type:'uri',uri:'https://example.com/staging',x:0,y:0,width:520,height:780},{type:'message',text:'STAGING',x:520,y:0,width:520,height:780}]}};
const seq = {mode:'sequence',items:[{type:'text',text:'STAGING intro'},{type:'card',source_message_id:7,message_config:im}]};
const clone = x => JSON.parse(JSON.stringify(x));
test('sequence imagemap saves without origin; builds ordered native messages and rejects invalid areas/limits',()=>{
 assert.equal(validateMessageConfig(seq).ok,true);
 const built=buildLineMessages(seq,{heroImageBaseUrl:'https://staging.example'});
 assert.equal(built.ok,true); assert.deepEqual(built.messages.map(x=>x.type),['text','imagemap']);
 assert.equal(built.messages[1].baseSize.height,780);
 assert.equal(built.messages[1].actions[0].linkUri,im.imagemap.areas[0].uri);
 assert.equal(built.messages[1].actions[1].text,'STAGING');
 const bad=clone(seq);bad.items[1].message_config.imagemap.areas[0].width=2000;
 assert.equal(validateMessageConfig(bad).ok,false);
 assert.equal(validateMessageConfig({mode:'sequence',items:Array(6).fill(seq.items[0])}).ok,false);
 assert.equal(buildLineMessages(im,{heroImageBaseUrl:'https://staging.example'}).ok,true);
});
async function editor(saved){
 const template=fs.readFileSync(require.resolve('../views/admin_message_sequence.ejs'),'utf8');
 const html=ejs.render(template,{user:'STAGING',isAdmin:true,bodyClass:'',include:(_n,o)=>o.body});
 const writes=[];
 const dom=new JSDOM(html,{url:'https://staging.example/admin/messages/sequence'+(saved?'?mid=8':''),runScripts:'dangerously',beforeParse(w){w.fetch=async(url,opts)=>{
 if(opts){writes.push(JSON.parse(opts.body));return {json:async()=>({ok:false,error:'STAGING capture'})};}
 return {json:async()=>url.includes('test-recipients')?{ok:true,recipients:[]}:url.endsWith('/list')?{messages:[{id:7,name:'STAGING rich',message_config:{...clone(im),imagemap:{...clone(im.imagemap),altText:'CHANGED SOURCE'}}}]}:{ok:true,message:{name:'STAGING saved',message_config:saved}}};};}});
 await new Promise(r=>setTimeout(r,25));return {dom,doc:dom.window.document,writes};
}
test('editor provides rich-message selection and keeps stored snapshot across reload, reorder and save',async()=>{
 const {dom,doc,writes}=await editor(clone(seq));
 try {
 assert.ok(doc.querySelector('[data-add="imagemap"]'));
 assert.ok(doc.querySelector('.msq-imagemap img'));
 doc.querySelector('[data-up="1"]').click();doc.querySelector('#msq-save').click();
 assert.equal(writes[0].message_config.items[0].message_config.imagemap.altText,'STAGING');
 assert.equal(writes[0].message_config.items[1].text,'STAGING intro');
 }finally{await new Promise(r=>setTimeout(r,0));dom.window.close();}
});
test('new rich-message segment copies chosen library content and supports removal',async()=>{
 const {dom,doc,writes}=await editor();try{
 assert.ok(doc.querySelector('[data-add="imagemap"]'));doc.querySelector('[data-add="text"]').click();
 doc.querySelector('[data-f="text"]').value='STAGING intro';doc.querySelector('[data-add="imagemap"]').click();
 const select=doc.querySelector('[data-card]');select.value='7';select.dispatchEvent(new dom.window.Event('change'));
 doc.querySelector('#msq-name').value='STAGING mixed';doc.querySelector('#msq-save').click();
 assert.equal(writes[0].message_config.items[1].message_config.mode,'imagemap');
 assert.equal(doc.querySelectorAll('.msq-imagemap [title]').length,2);
 doc.querySelector('[data-remove="1"]').click();assert.equal(doc.querySelectorAll('.msq-item').length,1);
 }finally{await new Promise(r=>setTimeout(r,0));dom.window.close();}
});
test('keyword webhook replies once with ordered text and native imagemap',async()=>{
 const crypto=require('node:crypto');
 const {createLineWebhookHandler}=require('../src/routes/lineWebhook');
 const previous=process.env.LINE_PUSH_PUBLIC_BASE_URL;process.env.LINE_PUSH_PUBLIC_BASE_URL='https://staging.example';
 const replies=[];
 const pool={query:async(sql)=>{
 if(sql.includes('FROM admin_keyword_replies'))return {rowCount:1,rows:[{id:7,keywords:'STAGING',match_type:'exact',message_template_id:8}]};
 if(sql.includes('SELECT message_config FROM admin_message_templates'))return {rowCount:1,rows:[{message_config:seq}]};
 return {rowCount:0,rows:[]};
 }};
 const handler=createLineWebhookHandler({pool,channelSecret:'STAGING_TEST_SECRET',linePush:{replyLineMessages:async(token,messages)=>{replies.push({token,messages});return true;}}});
 const body=Buffer.from(JSON.stringify({events:[{type:'message',replyToken:'STAGING_REPLY_TOKEN',message:{type:'text',text:'STAGING'}}]}));
 const signature=crypto.createHmac('sha256','STAGING_TEST_SECRET').update(body).digest('base64');
 const res={status(c){this.code=c;return this;},send(b){this.body=b;return this;},json(b){this.body=b;return this;}};
 try{await handler({body,get:()=>signature},res);assert.equal(replies.length,1);assert.deepEqual(replies[0].messages.map(m=>m.type),['text','imagemap']);assert.equal(replies[0].messages[1].actions[1].text,'STAGING');}
 finally{if(previous===undefined)delete process.env.LINE_PUSH_PUBLIC_BASE_URL;else process.env.LINE_PUSH_PUBLIC_BASE_URL=previous;}
});
