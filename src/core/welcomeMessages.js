const crypto=require('node:crypto');
const {validateMessageConfig}=require('./broadcastTemplates');
function classifyFollow({isUnblocked,hadPriorFriendEvidence}={}) {
 if(isUnblocked===true)return 'unblocked';
 if(isUnblocked===false && hadPriorFriendEvidence===false)return 'first';
 return 'unknown';
}
function createWelcomeService({pool,query,executionStore}) {
 async function load(){const r=await query('SELECT * FROM crm_welcome_settings WHERE id=1');return r.rows[0]||null;}
 async function save(input,actor) {
  if(input.messageId!=null && input.messageId!=='' && (!/^[1-9]\d*$/.test(String(input.messageId)) || !Number.isSafeInteger(Number(input.messageId))))throw new Error('message_id_invalid');
  if(input.enabled===true && input.duplicateCheckConfirmed!==true)throw new Error('duplicate_check_required');
  if(!Number.isSafeInteger(Number(input.revision))||Number(input.revision)<1)throw new Error('welcome_revision_required');
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   const r=await client.query('SELECT * FROM crm_welcome_settings WHERE id=1 FOR UPDATE');const old=r.rows[0];
   if(!old||Number(old.revision)!==Number(input.revision))throw new Error('welcome_revision_conflict');
   let snapshot=old.message_snapshot,name=old.message_name,messageId=old.message_id;
   if(input.messageId && (Number(input.messageId)!==Number(old.message_id)||input.refreshSnapshot===true)){
    if(!Number.isSafeInteger(Number(input.messageId))||Number(input.messageId)<1)throw new Error('message_id_invalid');
    const m=await client.query('SELECT id,name,message_config,channel FROM admin_message_templates WHERE id=$1',[Number(input.messageId)]);
    if(!m.rows[0]||(m.rows[0].channel||'line')!=='line')throw new Error('message_not_found');
    snapshot=m.rows[0].message_config;name=m.rows[0].name;messageId=m.rows[0].id;
   }
   if(input.enabled===true && (!snapshot||!validateMessageConfig(snapshot).ok))throw new Error('welcome_message_invalid');
   let flowId=old.managed_flow_id;
   if(!flowId && snapshot){
    const f=await client.query("INSERT INTO admin_flows(name,status,trigger_type,trigger_config,re_enroll,created_by) VALUES('加入好友歡迎訊息','draft','follow','{\"managed_welcome\":true}'::jsonb,true,$1) RETURNING id",[actor]);flowId=f.rows[0].id;
    await client.query("INSERT INTO admin_flow_nodes(flow_id,node_key,type,config,next_key,is_entry,position) VALUES($1,'welcome','send',$2::jsonb,NULL,true,0)",[flowId,JSON.stringify({message_id:messageId})]);
   }
   if(flowId)await client.query("UPDATE admin_flows SET status=$2,updated_at=now() WHERE id=$1 AND trigger_config->>'managed_welcome'='true'",[flowId,input.enabled===true?'active':'draft']);
   if(flowId)await client.query("UPDATE admin_flow_nodes SET config=$2::jsonb WHERE flow_id=$1 AND node_key='welcome'",[flowId,JSON.stringify({message_id:messageId})]);
   const out=await client.query(`UPDATE crm_welcome_settings SET enabled=$1,first_enabled=$2,unblocked_enabled=$3,message_id=$4,message_name=$5,message_snapshot=$6::jsonb,managed_flow_id=$7,revision=revision+1,updated_by=$8,updated_at=now() WHERE id=1 RETURNING *`,[input.enabled===true,input.firstEnabled!==false,input.unblockedEnabled===true,messageId,name,JSON.stringify(snapshot),flowId,actor]);
   await client.query('COMMIT');return out.rows[0];
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
 }
 async function claimFollow(lineUserId,evidence={}) {
  let settings;try{settings=await load();}catch(e){if(e.code==='42P01')return {skipped:'migration_required'};throw e;}
  if(!settings||!settings.enabled)return {skipped:'disabled'};
  const kind=classifyFollow(evidence);
  const eventId=evidence.webhookEventId || (Number.isFinite(evidence.timestamp)?crypto.createHash('sha256').update(JSON.stringify([lineUserId,evidence.timestamp,evidence.isUnblocked])).digest('hex'):null);
  if(!eventId)return {skipped:'event_identity_missing'};
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // Serializes disable/save and enrollment, and ensures the current snapshot is used.
   const latest=await client.query('SELECT * FROM crm_welcome_settings WHERE id=1 FOR UPDATE');settings=latest.rows[0];
   if(!settings?.enabled){await client.query('COMMIT');return {skipped:'disabled'};}
   const claim=await executionStore.claim(client,{sourceType:'welcome',sourceId:1,sourceEventId:eventId,recipientKey:lineUserId,messageSnapshot:settings.message_snapshot,revision:Number(settings.revision)});
   if(!claim.claimed){
    // A redelivery can reach this lock before the request that inserted the user.
    // Permit only stronger evidence for the SAME event to upgrade an unknown skip.
    if(kind!=='unknown' && claim.execution?.status==='skipped' && claim.execution.reason==='follow_identity_unknown') {
     const upgraded=await client.query("UPDATE crm_message_executions SET status='pending',reason=NULL,finished_at=NULL WHERE id=$1 AND status='skipped' AND reason='follow_identity_unknown' RETURNING *",[claim.execution.id]);
     if(!upgraded.rows.length){await client.query('COMMIT');return {skipped:'duplicate'};}
     claim.execution=upgraded.rows[0];
    }else{await client.query('COMMIT');return {skipped:'duplicate'};}
   }
   const skip=kind==='unknown'?'follow_identity_unknown':kind==='first'&&!settings.first_enabled?'first_disabled':kind==='unblocked'&&!settings.unblocked_enabled?'unblocked_disabled':null;
   if(skip){await client.query("UPDATE crm_message_executions SET status='skipped',reason=$2,finished_at=now() WHERE id=$1",[claim.execution.id,skip]);await client.query('COMMIT');return {skipped:skip};}
   const enrolled=await client.query(`INSERT INTO admin_flow_enrollments(flow_id,user_id,line_user_id,status,current_node_key,next_run_at,context)
    VALUES($1,NULL,$2,'active','welcome',now(),$3::jsonb) ON CONFLICT(flow_id,line_user_id) WHERE status='active' DO NOTHING RETURNING id`,[settings.managed_flow_id,lineUserId,JSON.stringify({trigger:'follow',executionId:claim.execution.id,welcomeRevision:Number(settings.revision)})]);
   if(!enrolled.rows.length)await client.query("UPDATE crm_message_executions SET status='skipped',reason='welcome_already_active',finished_at=now() WHERE id=$1",[claim.execution.id]);
   await client.query('COMMIT');return {enrolled:!!enrolled.rows.length};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
 }
 return {load,save,claimFollow};
}
module.exports={classifyFollow,createWelcomeService};
