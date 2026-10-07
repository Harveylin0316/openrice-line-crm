const test=require('node:test');const assert=require('node:assert/strict');
const {createFlowEngine}=require('../src/core/flowEngine');const {buildLineMessages}=require('../src/core/broadcastTemplates');
function harness({failPrepare=false,statuses=[429,200]}={}){
 let execution=null,calls=0,fail=failPrepare;const updates=[];const cfg={mode:'sequence',items:[{type:'text',text:'STAGING original'}]};
 const query=async(sql,p=[])=>{
  if(sql.includes('FROM admin_flow_nodes'))return {rows:[{node_key:'send',type:'send',config:{message_id:1},next_key:null}],rowCount:1};
  if(sql.includes('FROM admin_message_templates'))return cfg.deleted ? {rows:[],rowCount:0} : {rows:[{name:'STAGING',message_config:cfg}],rowCount:1};
  if(sql.includes('FROM users'))return {rows:[],rowCount:0};
  if(sql.includes('to_regclass'))return {rows:[{table_name:'crm_message_executions'}]};
  if(sql.includes('INSERT INTO crm_message_executions')){if(execution)return {rows:[]};execution={id:1,code:'STAGINGcode',status:'pending',message_snapshot:JSON.parse(p[5])};return {rows:[{...execution}]};}
  if(sql.startsWith('SELECT * FROM crm_message_executions'))return {rows:execution?[{...execution}]:[]};
  if(sql.includes('SET targets=')){if(fail){fail=false;throw new Error('STAGING temporary database error')}return {rows:[]};}
  if(sql.includes("SET status='pending'")){if(execution.status==='rejected'&&execution.reason==='line_rate_limited'){execution.status='pending';execution.reason=null;return {rows:[{...execution}]};}return {rows:[]};}
  if(sql.includes("SET status='sending'")){if(execution.status!=='pending')return {rows:[]};execution.status='sending';return {rows:[{...execution}]};}
  if(sql.includes('UPDATE crm_message_executions SET status=$2')){execution.status=p[1];execution.reason=p[2];return {rows:[{...execution}]};}
  if(sql.includes('UPDATE admin_flow_enrollments')){updates.push({sql,p});return {rows:[]};}
  return {rows:[],rowCount:0};
 };
 const sent=[];const engine=createFlowEngine({query,pool:{},buildLineMessages,linePush:{pushLineMessages:async(id,messages)=>{sent.push(messages);const status=statuses[Math.min(calls++,statuses.length-1)];return {ok:status===200,httpStatus:status,status:status===200?'success':'failed'};}}});
 const enrollment={id:1,flow_id:1,line_user_id:'STAGING_RECIPIENT',current_node_key:'send',context:{trigger:'follow'},retry_count:0};
 return {run:()=>engine._processEnrollment(enrollment),updates,sent,cfg,get execution(){return execution}};
}
test('ordinary automation retries known 429 rejection with frozen content',async()=>{
 const h=harness();await h.run();assert.equal(h.execution.reason,'line_rate_limited');assert.ok(h.updates.some(u=>u.sql.includes('SET retry_count')));
 h.cfg.items[0].text='STAGING changed';await h.run();assert.equal(h.execution.status,'accepted');assert.equal(h.sent[1][0].text,'STAGING original');
 await h.run();assert.equal(h.sent.length,2,'accepted execution must never send again');
});
test('pending execution resumes after pre-send database failure; timeout never blindly resends',async()=>{
 const h=harness({failPrepare:true,statuses:[200]});await h.run();assert.equal(h.sent.length,0);assert.equal(h.execution.status,'pending');await h.run();assert.equal(h.sent.length,1);
 const timeout=harness({statuses:[null]});await timeout.run();assert.equal(timeout.execution.status,'uncertain');await timeout.run();assert.equal(timeout.sent.length,1);
});

test('automation resumes frozen pending content after source asset deletion',async()=>{
 const h=harness({failPrepare:true,statuses:[200]});await h.run();h.cfg.deleted=true;await h.run();assert.equal(h.sent.length,1);assert.equal(h.sent[0][0].text,'STAGING original');await h.run();assert.equal(h.sent.length,1);
});
