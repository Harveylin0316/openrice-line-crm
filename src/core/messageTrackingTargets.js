function safeUri(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}
function alreadyTracked(uri){return /\/(?:r\/b|rf|t\/(?:m|x|e))\//.test(uri);}
function collectMessageTargets(messages){
 const targets=[],textTargets=[],warnings=[];
 function add(node,key,path,slot,kind,label,start,end){const uri=node[key];if(!safeUri(uri)||alreadyTracked(uri))return;targets.push({index:targets.length,slotIndex:slot,cardIndex:path.includes('contents') && messages[slot]?.contents?.type==='carousel' ? path[3] : messages[slot]?.type==='flex' ? 0 : null,actionIndex:targets.length,kind,uri,label:label||null,path:[...path,key]});}
 function walk(node,path,slot){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach((v,i)=>walk(v,[...path,i],slot));return;}
  if(node.action?.type==='uri')add(node.action,'uri',[...path,'action'],slot,'uri_action',node.action.label||node.text);
  if(node.type==='uri'&&node.area)add(node,'linkUri',path,slot,'uri_action',node.label);
  for(const [key,value] of Object.entries(node)){if(key!=='action')walk(value,[...path,key],slot);}
 }
 (messages||[]).forEach((message,slot)=>{
  walk(message,[slot],slot);
  if(message.type==='text'&&typeof message.text==='string'){
   const re=/https?:\/\/[^\s<>"，。！？；「」『』【】]+/gu;let match;
   while((match=re.exec(message.text))){let uri=match[0].replace(/[.,!?;:]+$/,'');if(/[()]/.test(uri)){warnings.push({slotIndex:slot,reason:'ambiguous_text_url'});continue;}
    if(safeUri(uri)&&!alreadyTracked(uri))textTargets.push({slotIndex:slot,cardIndex:null,kind:'text_url',uri,label:null,path:[slot,'text'],start:match.index,end:match.index+uri.length});
   }
  }
 });
 textTargets.forEach(t=>targets.push({...t,index:targets.length,actionIndex:targets.length}));return {targets,warnings};
}
function wrapExecutionTargets(messages,targets,urlForIndex){
 const output=JSON.parse(JSON.stringify(messages));
 for(const t of targets.filter(t=>t.kind!=='text_url')){let node=output;for(const key of t.path.slice(0,-1))node=node[key];node[t.path.at(-1)]=urlForIndex(t.index);}
 for(const t of targets.filter(t=>t.kind==='text_url').sort((a,b)=>b.start-a.start)){const m=output[t.slotIndex];m.text=m.text.slice(0,t.start)+urlForIndex(t.index)+m.text.slice(t.end);}
 return output;
}
async function prepareExecutionTracking(query,execution,messages,origin){
 const liffId=process.env.GAMES_LIFF_ID||process.env.WHEEL_LIFF_ID||process.env.LIFF_ID;
 const {targets}=collectMessageTargets(messages);targets.forEach(t=>{t.tracked=!!liffId;});await query("UPDATE crm_message_executions SET targets=$2::jsonb WHERE id=$1 AND status='pending'",[execution.id,JSON.stringify(targets)]);
 if(!liffId)return messages;
 return wrapExecutionTargets(messages,targets,i=>'https://liff.line.me/'+encodeURIComponent(liffId)+'/t/e/'+execution.code+'/'+i);
}
module.exports={collectMessageTargets,wrapExecutionTargets,prepareExecutionTracking,safeUri};
