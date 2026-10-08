const {createMessagePerformance,parsePerformanceFilters}=require('../core/messagePerformance');
const {createMessagePerformanceList}=require('../core/messagePerformanceList');
function registerAdminMessagePerformance(app,{query,authCore,resolvePublicSiteOrigin=()=>''}) {
 // 以「一則訊息」為一列的新版列表與單則明細（舊的 /api、/executions 端點保留相容）
 const listService=createMessagePerformanceList({query});
 const originOf=(req)=>String(resolvePublicSiteOrigin(req)||'').replace(/\/+$/,'');
 app.get('/admin/message-performance/messages',authCore.requireAdmin,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{parsePerformanceFilters(req.query);}catch(e){return res.status(400).json({ok:false,error:e.message});}
  try{return res.json({ok:true,...await listService.list(req.query,originOf(req))});}
  catch(e){console.error('message performance list failed:',e&&e.message);return res.status(503).json({ok:false,error:'成效資料暫時無法讀取'});}
 });
 app.get('/admin/message-performance/messages/detail',authCore.requireAdmin,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{return res.json({ok:true,...await listService.detail(req.query,originOf(req))});}
  catch(e){return res.status(400).json({ok:false,error:e.message||'明細無法讀取'});}
 });
 const service=createMessagePerformance({query});const guard=authCore.requireAdmin;
 app.get('/admin/message-performance',guard,(req,res)=>res.render('admin_message_performance',{user:req.authUser?.un||'',isAdmin:true,title:'訊息成效'}));
 for(const [path,method] of [['/api','summary'],['/executions','executions'],['/executions/:id','details']]){
  app.get('/admin/message-performance'+path,guard,async(req,res)=>{
   res.setHeader('Cache-Control','no-store');
   try{if(method!=='details')parsePerformanceFilters(req.query);else if(!/^[1-9]\d{0,14}$/.test(String(req.params.id)))throw new Error('執行編號不正確');}catch(e){return res.status(400).json({ok:false,error:e.message});}
   try{return res.json({ok:true,...await service[method](method==='details'?req.params.id:req.query)});}catch{return res.status(503).json({ok:false,error:'成效資料暫時無法讀取'});}
  });
 }
}
module.exports={registerAdminMessagePerformance};
