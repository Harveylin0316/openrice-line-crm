const test=require('node:test'),assert=require('node:assert/strict');
const {createFlowEngine}=require('../src/core/flowEngine');
const {registerAdminFlowsRoutes}=require('../src/routes/adminFlows');
async function period(config,time,active=true){
 const keys=[];const query=async(sql,p)=>{if(sql.includes("FROM admin_flows WHERE status = 'active'"))return {rows:active?[{id:7,trigger_config:config}]:[]};if(sql.includes('INSERT INTO admin_flow_schedule_runs'))keys.push(p[1]);if(sql.includes('SELECT completed_at'))return {rows:[{completed_at:new Date()}]};return {rows:[],rowCount:0};};
 await createFlowEngine({query,pool:{},linePush:{}}).runScheduleTriggers(new Date(time));return keys;
}
test('first start gates recurring daily trigger down to minute',async()=>{
 const c={freq:'daily',hour:10,minute:32,start_date:'2026-11-15'};
 assert.deepEqual(await period(c,'2026-11-14T10:32:00+08:00'),[]);
 assert.deepEqual(await period(c,'2026-11-15T10:31:59+08:00'),[]);
 assert.equal((await period(c,'2026-11-15T10:32:00+08:00')).length,1);
 assert.equal((await period(c,'2026-11-16T10:32:00+08:00')).length,1);
 assert.deepEqual(await period(c,'2026-11-15T10:32:00+08:00',false),[]);
});
test('23:59 schedule can resume immediately after midnight without using next-day key',async()=>{
 const c={freq:'daily',hour:23,minute:59,start_date:'2026-11-15'};
 assert.deepEqual(await period(c,'2026-11-16T00:01:00+08:00'),['D2026-11-15']);
});
test('save retains exact minute and derives weekly/monthly anchor from first date',async()=>{
 for(const freq of ['daily','weekly','monthly']){
  const routes={};let saved;
  const q=async(sql,p)=>{if(sql.includes('INSERT INTO admin_flows')){saved=JSON.parse(p[2]);return {rows:[{id:7}]};}return {rows:[],rowCount:0};};
  const app={};for(const m of ['get','put','post','delete'])app[m]=(p,...h)=>routes[m+' '+p]=h;
  registerAdminFlowsRoutes(app,{query:q,pool:{connect:async()=>({query:q,release(){}})},flowEngine:{},authCore:{requireAdmin:(_q,_s,n)=>n()}});
  const res={status(n){this.code=n;return this},json(b){this.body=b;return this}};
  const call=async(config)=>routes['post /admin/flows/api'].at(-1)({authUser:{un:'STAGING'},body:{name:'STAGING',trigger:{type:'schedule',config},steps:[{type:'send',message_id:1}]}},res);
  await call({freq,hour:10,minute:32,start_date:'2050-11-15',audience:{type:'all'}});
  assert.equal(res.body.ok,true);assert.equal(saved.minute,32);assert.equal(saved.start_date,'2050-11-15');
  if(freq==='weekly')assert.equal(saved.dow,new Date('2050-11-15T00:00:00Z').getUTCDay());
  if(freq==='monthly')assert.equal(saved.dom,15);
  await call({freq,hour:10,minute:32,start_date:'2050-02-30'});assert.equal(res.code,400);
 }
});
