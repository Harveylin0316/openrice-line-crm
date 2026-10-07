const crypto=require('node:crypto');
function snapshotRevision(config){return parseInt(crypto.createHash('sha256').update(JSON.stringify(config||{})).digest('hex').slice(0,12),16)+1;}
const SOURCES=['welcome','broadcast','automation','keyword'];
function createMessageExecutionStore({query}) {
 async function claim(client,input) {
  if(!SOURCES.includes(input.sourceType)||!Number.isSafeInteger(Number(input.sourceId))||Number(input.sourceId)<=0||!input.sourceEventId||!input.recipientKey)throw new Error('execution_identity_invalid');
  const code=crypto.randomBytes(24).toString('base64url');
  const result=await client.query(`INSERT INTO crm_message_executions(code,source_type,source_id,source_event_id,recipient_key,message_snapshot,targets,variant,test_only,revision)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) ON CONFLICT(source_type,source_id,source_event_id,recipient_key) DO NOTHING RETURNING *`,
   [code,input.sourceType,input.sourceId,input.sourceEventId,input.recipientKey,JSON.stringify(input.messageSnapshot||{}),JSON.stringify(input.targets||[]),input.variant||null,!!input.testOnly,input.revision||snapshotRevision(input.messageSnapshot)]);
  if(result.rows.length)return {claimed:true,execution:result.rows[0]};
  const existing=await client.query('SELECT * FROM crm_message_executions WHERE source_type=$1 AND source_id=$2 AND source_event_id=$3 AND recipient_key=$4',[input.sourceType,input.sourceId,input.sourceEventId,input.recipientKey]);
  return {claimed:false,execution:existing.rows[0]||null};
 }
 async function finish(id,{status,reason=null}) {
  if(!['accepted','rejected','uncertain','skipped'].includes(status))throw new Error('execution_status_invalid');
  const result=await query("UPDATE crm_message_executions SET status=$2,reason=$3,finished_at=now() WHERE id=$1 AND status IN ('pending','sending') RETURNING *",[id,status,reason]);
  return result.rows[0]||null;
 }
 async function get(id){const r=await query('SELECT * FROM crm_message_executions WHERE id=$1',[id]);return r.rows[0]||null;}
 async function begin(id){const r=await query("UPDATE crm_message_executions SET status='sending',started_at=now() WHERE id=$1 AND status='pending' RETURNING *",[id]);return r.rows[0]||null;}
 async function retryRejected(id){const r=await query("UPDATE crm_message_executions SET status='pending',reason=NULL,started_at=NULL,finished_at=NULL WHERE id=$1 AND status='rejected' AND reason='line_rate_limited' RETURNING *",[id]);return r.rows[0]||null;}
 return {claim,finish,get,begin,retryRejected};
}
module.exports={createMessageExecutionStore,SOURCES,snapshotRevision};
