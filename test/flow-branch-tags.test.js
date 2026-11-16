const test=require('node:test'),assert=require('node:assert/strict');
const {registerAdminFlowsRoutes}=require('../src/routes/adminFlows');
function harness(){
 const routes={},nodes=[];let config;const tags=[{id:11,name:'STAGING A',color:'#123456'},{id:12,name:'STAGING B',color:'#abcdef'}];
 const query=async(sql,p=[])=>{
  if(sql.includes('INSERT INTO admin_flows')){config=JSON.parse(p[2]);return {rows:[{id:5}],rowCount:1};}
  if(sql.includes('INSERT INTO admin_flow_nodes')){nodes.push({node_key:p[1],type:p[2],config:JSON.parse(p[3]),next_key:p[4],branch_true_key:p[5],branch_false_key:p[6],is_entry:p[7]});}
  if(sql.includes('FROM user_tags'))return {rows:tags.filter(t=>p[0]?.includes?.(t.id)||p[0]===t.name),rowCount:1};
  if(sql.includes('INSERT INTO user_tags'))return {rows:[],rowCount:0};
  if(sql.includes('SELECT * FROM admin_flows'))return {rows:[{id:5,name:'STAGING',trigger_type:'follow',trigger_config:config}],rowCount:1};
  if(sql.includes('SELECT * FROM admin_flow_nodes'))return {rows:nodes,rowCount:nodes.length};
  return {rows:[],rowCount:0};
 };
 const app={};for(const method of ['get','post','put','delete'])app[method]=(path,...handlers)=>routes[method+' '+path]=handlers;
 registerAdminFlowsRoutes(app,{query,pool:{connect:async()=>({query,release(){}})},flowEngine:{},authCore:{requireAdmin:(_q,_s,n)=>n()}});
 async function call(path,body){const res={code:200,status(n){this.code=n;return this},json(b){this.body=b;return this}};const h=routes[path];assert.ok(h,'route exists '+path);await h.at(-1)({body,params:{id:'5'},authUser:{un:'STAGING'}},res);return res;}
 return {call,nodes};
}
const body=()=>({name:'STAGING',trigger:{type:'follow',config:{}},steps:[{type:'ab_split',mode:'random',a:[{type:'add_tag',tag_id:11,ttl_days:7}],b:[{type:'add_tag',tag_id:12,ttl_days:null}]}]});
test('AB branch tags save and reopen with independent tags and expiry',async()=>{const h=harness();assert.equal((await h.call('post /admin/flows/api',body())).body.ok,true);const r=await h.call('get /admin/flows/api/:id');assert.deepEqual(r.body.flow.steps[0].a,body().steps[0].a);assert.deepEqual(r.body.flow.steps[0].b,body().steps[0].b);});
test('nested tag IDs require safe positive integers and existing tags',async()=>{for(const id of [null,-1,'1x',1.2,999]){const h=harness(),b=body();b.steps[0].a[0].tag_id=id;assert.equal((await h.call('post /admin/flows/api',b)).code,400);assert.equal(h.nodes.length,0);}});
test('inline tag creation selects existing name without changing color',async()=>{const h=harness();const r=await h.call('post /admin/flows/api/tags',{name:' STAGING A '});assert.equal(r.body.ok,true);assert.equal(r.body.tag.color,'#123456');assert.equal((await h.call('post /admin/flows/api/tags',{name:' '})).code,400);});
test('saved AB grouping executes only its own tag path, including repeated execution',async()=>{
 const {createFlowEngine}=require('../src/core/flowEngine');
 for(const variant of ['a','b']){
  const writes=[],nodes={split:{node_key:'split',type:'ab_split',config:{mode:'random'},branch_true_key:'a',branch_false_key:'b'},a:{type:'add_tag',config:{tag_id:11}},b:{type:'add_tag',config:{tag_id:12}}};
  const query=async(sql,p)=>{if(sql.includes('FROM admin_flow_nodes'))return {rows:[nodes[p[1]]],rowCount:1};if(sql.includes('INSERT INTO user_tag_members'))writes.push(p[0]);return {rows:[],rowCount:0};};
  const engine=createFlowEngine({query,pool:{},linePush:{}});
  const en={id:1,flow_id:5,line_user_id:'STAGING_BRANCH_QA',current_node_key:'split',context:{ab_variant:variant}};
  await engine._processEnrollment(en);await engine._processEnrollment(en);
  assert.deepEqual(writes,[variant==='a'?11:12,variant==='a'?11:12]);
 }
});
