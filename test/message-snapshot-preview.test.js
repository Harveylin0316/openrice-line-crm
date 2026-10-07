const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {JSDOM}=require('jsdom');
test('snapshot preview renders text then native imagemap areas and never activates tracking',()=>{
 const dom=new JSDOM('<div id="p"></div>',{runScripts:'outside-only'});dom.window.eval(fs.readFileSync('public/message-snapshot-preview.js','utf8'));
 dom.window.renderMessageSnapshot(dom.window.document.getElementById('p'),[{type:'text',text:'<img onerror=bad>'},{type:'imagemap',baseUrl:'https://example.com/image',baseSize:{width:1040,height:780},actions:[{type:'uri',linkUri:'https://example.com/?variant=b',area:{x:0,y:0,width:1040,height:780}}]}]);
 const p=dom.window.document.getElementById('p');assert.match(p.textContent,/<img onerror=bad>/);assert.equal(p.querySelectorAll('img').length,1);assert.equal(p.querySelectorAll('a').length,0);assert.match(p.textContent,/variant=b/);dom.window.close();
});
