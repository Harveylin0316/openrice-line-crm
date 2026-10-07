const {createMessagePerformance,parsePerformanceFilters}=require('../core/messagePerformance');
function registerAdminMessagePerformance(app,{query,authCore}) {
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
