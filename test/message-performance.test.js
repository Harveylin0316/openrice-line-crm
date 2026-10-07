const test=require('node:test');const assert=require('node:assert/strict');
test('metrics distinguish unavailable from real zero and use Taipei inclusive dates',()=>{
 const {parsePerformanceFilters,metricRow}=require('../src/core/messagePerformance');
 const f=parsePerformanceFilters({from:'2026-10-05',to:'2026-10-05',source:'welcome'});assert.equal(f.from,'2026-10-05T00:00:00+08:00');assert.equal(f.to,'2026-10-06T00:00:00+08:00');
 assert.throws(()=>parsePerformanceFilters({from:'2026-02-30',to:'2026-03-01'}));assert.throws(()=>parsePerformanceFilters({source:'sql'}));
 assert.equal(metricRow({accepted:0,clicks:0,people:0,clickers:0,tracked:true}).rate,null);
 assert.equal(metricRow({accepted:5,clicks:0,people:5,clickers:0,tracked:true}).rate,0);
 assert.equal(metricRow({accepted:5,tracked:false}).clickCount,null);
});
test('performance endpoints require admin and propagate database failures',async()=>{
 const {registerAdminMessagePerformance}=require('../src/routes/adminMessagePerformance');const routes={};const guard=()=>{};
 registerAdminMessagePerformance({get(p,...h){routes[p]=h}},{query:async()=>{throw new Error('private database detail')},authCore:{requireAdmin:guard}});
 assert.equal(routes['/admin/message-performance/api'][0],guard);
 const res={status(n){this.code=n;return this},json(b){this.body=b},setHeader(){}};
 await routes['/admin/message-performance/api'].at(-1)({query:{}},res);assert.equal(res.code,503);assert.equal(res.body.error,'成效資料暫時無法讀取');
});
test('performance page preserves welcome source option and source filter',async()=>{
 const ejs=require('ejs'),path=require('node:path');const {JSDOM}=require('jsdom');
 const html=await ejs.renderFile(path.join(__dirname,'../views/admin_message_performance.ejs'),{user:'STAGING',isAdmin:true,title:'STAGING'});
 const doc=new JSDOM(html).window.document;const select=doc.querySelector('select[name="source"]');select.value='welcome';assert.equal(select.value,'welcome');
});
