const crypto=require('node:crypto');
const {verifyLiffIdToken,channelIdFromLiffId}=require('../core/liffAuth');
const {safeUri}=require('../core/messageTrackingTargets');
function registerMessageExecutionTracking(app,{query}){
 const liffId=()=>process.env.GAMES_LIFF_ID||process.env.WHEEL_LIFF_ID||process.env.LIFF_ID||'';
 async function target(req){if(!/^[A-Za-z0-9_-]{32}$/.test(req.params.code)||!/^\d{1,4}$/.test(req.params.index))return null;
  const rs=await query('SELECT * FROM crm_message_executions WHERE code=$1',[req.params.code]);const e=rs.rows[0];const t=e?.targets?.find(t=>t.index===Number(req.params.index));return t&&safeUri(t.uri)?{execution:e,target:t}:null;
 }
 for(const base of ['/t/e','/games/t/e']){
  app.get(base+'/:code/:index',async(req,res)=>{try{const hit=await target(req);if(!hit)return res.status(404).send('找不到連結');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');return res.render('tap_bounce',{target:hit.target.uri,liffId:liffId(),recordUrl:'/t/e/'+req.params.code+'/'+req.params.index+'/hit'});}catch{return res.status(503).send('暫時無法讀取連結，請稍後重試');}});
  app.post(base+'/:code/:index/hit',async(req,res)=>{try{
   const hit=await target(req);if(!hit||hit.execution.test_only||hit.execution.status!=='accepted')return res.json({ok:true,recorded:false});
   const verified=await verifyLiffIdToken(String(req.body?.id_token||''),channelIdFromLiffId(liffId()));
   if(!verified.ok||verified.sub!==hit.execution.recipient_key)return res.status(403).json({ok:false,error:'unverified_recipient'});
   // One identity/action per short time bucket prevents bounce retries from inflating counts.
   const key=crypto.createHash('sha256').update([verified.sub,hit.target.index,Math.floor(Date.now()/30000)].join(':')).digest('hex');
   const values=[hit.execution.id,hit.target.index,verified.sub,key];
   const insert='INSERT INTO crm_message_clicks(execution_id,action_index,verified_identity,event_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id';
   const parts=String(hit.execution.source_event_id||'').split(':');
   if(hit.execution.source_type==='automation' && parts.length>=2 && parts.slice(0,2).every(p=>/^[1-9]\d*$/.test(p))){
    // One statement commits the new click and legacy branch signal together.
    await query('WITH inserted AS ('+insert+') INSERT INTO admin_flow_clicks(enrollment_id,line_user_id,message_id,target_url) SELECT $5,$3,$6,$7 FROM inserted',[...values,parts[0],parts[1],hit.target.uri]);
   }else await query(insert,values);
   return res.json({ok:true,recorded:true});
  }catch{return res.status(503).json({ok:false,error:'tracking_unavailable'});}});
 }
}
module.exports={registerMessageExecutionTracking};
