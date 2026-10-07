const {createWelcomeService}=require('../core/welcomeMessages');
const {createMessageExecutionStore}=require('../core/messageExecutions');
const {buildLineMessages}=require('../core/broadcastTemplates');
function registerAdminWelcomeMessagesRoutes(app,{query,pool,authCore,linePush,resolvePublicSiteOrigin=()=>''}) {
 const store=createMessageExecutionStore({query});const service=createWelcomeService({query,pool,executionStore:store});const guard=authCore.requireAdmin;
 const fail=(res,e)=>res.status(e.code==='42P01'?503:400).json({ok:false,error:e.code==='42P01'?'migration_required':e.message});
 app.get('/admin/welcome-messages',guard,(req,res)=>res.render('admin_welcome_messages',{user:req.authUser?.un||'',isAdmin:true,title:'加入好友歡迎訊息'}));
 app.get('/admin/welcome-messages/api',guard,async(req,res)=>{try{
  const settings=await service.load();
  const flows=await query("SELECT id,name FROM admin_flows WHERE status='active' AND trigger_type='follow' AND COALESCE(trigger_config->>'managed_welcome','false')<>'true'");
  const testers=await query('SELECT id,label FROM admin_test_recipients ORDER BY id');
  res.json({ok:true,settings,flows:flows.rows,testers:testers.rows});
 }catch(e){fail(res,e);}});
 app.post('/admin/welcome-messages/api',guard,async(req,res)=>{try{res.json({ok:true,settings:await service.save(req.body||{},req.authUser?.un||'admin')});}catch(e){fail(res,e);}});
 app.post('/admin/welcome-messages/preview',guard,async(req,res)=>{try{
  const saved=await service.load();let cfg=saved?.message_snapshot;
  if(req.body?.messageId){if(!/^[1-9]\d{0,14}$/.test(String(req.body.messageId)))throw new Error('message_id_invalid');const r=await query("SELECT message_config FROM admin_message_templates WHERE id=$1 AND COALESCE(channel,'line')='line'",[req.body.messageId]);cfg=r.rows[0]?.message_config;}
  const built=buildLineMessages(cfg,{heroImageBaseUrl:resolvePublicSiteOrigin(req)});res.json(built);
 }catch(e){fail(res,e);}});
 app.post('/admin/welcome-messages/test',guard,async(req,res)=>{try{
  if(process.env.SAFE_PREVIEW_MODE==='1'||process.env.APP_ENV==='staging')return res.json({ok:true,skipped:true,reason:'safe_preview'});
  const id=Number(req.body?.testRecipientId);if(!Number.isSafeInteger(id)||id<=0)throw new Error('test_recipient_required');
  const target=await query('SELECT line_user_id FROM admin_test_recipients WHERE id=$1',[id]);if(!target.rows[0])throw new Error('test_recipient_not_found');
  const settings=await service.load();if(!settings?.message_snapshot)throw new Error('save_before_test');
  const built=buildLineMessages(settings.message_snapshot,{heroImageBaseUrl:resolvePublicSiteOrigin(req)});if(!built.ok)throw new Error(built.error);
  const valid=await linePush.validatePushMessages(built.messages);if(!valid.ok)throw new Error(valid.detail||'line_validation_failed');
  const result=await linePush.pushLineMessages(target.rows[0].line_user_id,built.messages,{pushType:'welcome_test',returnResult:true,timeoutMs:8000});
  res.json({ok:result.ok,status:result.status,error:result.detail||null});
 }catch(e){fail(res,e);}});
}
module.exports={registerAdminWelcomeMessagesRoutes};
