// Proposed ingress only. No production route or credential is configured here.
const MAX_RAW=256*1024, MAX_QUEUED=80*1024;
const ORIGINS={qa:'https://staging--openrice-line-crm.netlify.app',production:'https://openrice-line-crm.netlify.app'};
function target(env,path){
 const origin=ORIGINS[env.MODE];
 if(!origin||env.NETLIFY_ORIGIN!==origin)throw Error('invalid_target');
 return origin+'/.netlify/functions/'+path;
}
async function readLimited(request){
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();
 const parts=[];let length=0;
 while(true){const {value,done}=await reader.read();if(done)break;
  length+=value.length;if(length>MAX_RAW){await reader.cancel();throw Error('too_large');}parts.push(value);}
 const body=new Uint8Array(length);let at=0;for(const p of parts){body.set(p,at);at+=p.length;}return body;
}
function encode(raw){let s='';for(let i=0;i<raw.length;i+=16384)s+=String.fromCharCode(...raw.subarray(i,i+16384));return btoa(s);}
function decode(s){if(typeof s!=='string'||s.length>Math.ceil(MAX_QUEUED/3)*4)throw Error('bad_envelope');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function verified(cryptoApi,secret,raw,signed){
 if(!secret||typeof signed!=='string'||signed.length>128)return false;
 let sig;try{sig=Uint8Array.from(atob(signed),c=>c.charCodeAt(0));}catch{return false;}
 if(sig.length!==32)return false;
 const key=await cryptoApi.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return cryptoApi.subtle.verify('HMAC',key,sig,raw);
}
export function createIngress({fetcher=fetch,cryptoApi=globalThis.crypto,log=console.info}={}){
 const reply=status=>new Response(status===200?'{}':'',{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 async function post(env,path,raw,signed){return fetcher(target(env,path),{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-line-signature':signed},body:raw,signal:AbortSignal.timeout(8000)});}
 return {
  async fetch(request,env){
   const path=new URL(request.url).pathname;
   if(path==='/healthz'&&request.method==='GET')return Response.json({service:'line-webhook-ingress',mode:env.MODE,version:1,productionEnabled:env.MODE==='production'&&env.ENABLED==='1'});
   if(path!=='/webhooks/line')return reply(404);
   if(request.method!=='POST')return reply(405);
   if(env.ENABLED!=='1'||!env.LINE_CHANNEL_SECRET||!env.LINE_QUEUE)return reply(503);
   try{target(env,'line-webhook-worker-background');}catch{return reply(503);}
   let raw;try{raw=await readLimited(request);}catch{return reply(413);}
   const signed=request.headers.get('x-line-signature')||'';
   if(!await verified(cryptoApi,env.LINE_CHANNEL_SECRET,raw,signed))return reply(401);
   let body;try{body=JSON.parse(new TextDecoder().decode(raw));}catch{return reply(400);}
   if(!Array.isArray(body.events)||body.events.length>1000||body.events.some(e=>!e||typeof e.webhookEventId!=='string'||!e.webhookEventId||e.webhookEventId.length>200))return reply(400);
   if(!body.events.length)return reply(200);
   if(raw.length>MAX_QUEUED){
    // Retain existing large-batch limits and DB-before-ack semantics. Such a
    // request can still time out; never silently drop it or pretend queued.
    try{return await post(env,'line-webhook-receiver',raw,signed);}catch{return reply(503);}
   }
   try{
    // Await durable enqueue; no waitUntil or untracked background promise.
    await env.LINE_QUEUE.send({version:1,raw:encode(raw),signature:signed},{contentType:'json'});
   }catch{log(JSON.stringify({event:'line_ingress_enqueue_failed'}));return reply(503);}
   return reply(200);
  },
  async queue(batch,env){
   for(const message of batch.messages){
    let accepted=false;
    try{
     const e=message.body;
     if(e?.version!==1)throw Error('bad_envelope');
     const raw=decode(e.raw);
     if(!await verified(cryptoApi,env.LINE_CHANNEL_SECRET,raw,e.signature))throw Error('bad_signature');
     const r=await post(env,'line-webhook-worker-background',raw,e.signature);
     // A 202 means Netlify durably accepted the invocation, not LINE delivery.
     // Unknown/failed transport is safe to re-deliver: DB event_id dedupes it.
     accepted=r.status===202;
    }catch{}
    if(accepted)message.ack();
    else{message.retry({delaySeconds:Math.min(300,5*2**Math.min(message.attempts||1,6))});log(JSON.stringify({event:'line_ingress_relay_deferred'}));}
   }
  },
 };
}
export default createIngress();
