const crypto = require('node:crypto');
function normalizeExcludedBroadcastIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('exclude_broadcast_ids_invalid');
  const ids = raw.map(value => {
    if (!['number','string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('exclude_broadcast_ids_invalid');
    return Number(value);
  });
  return [...new Set(ids)].sort((a,b)=>a-b);
}
async function loadExcludedTestRecipients(query, ids) {
  if (!ids.length) return new Set();
  const sources = await query('SELECT id, channel, is_ab_test, audience_config FROM admin_broadcasts WHERE id = ANY($1::bigint[])',[ids]);
  if (sources.rows.length !== ids.length || sources.rows.some(r => (r.channel || 'line') !== 'line' || (!r.is_ab_test && !r.audience_config?.experiment?.enabled))) throw new Error('exclusion_source_invalid');
  const rows = await query("SELECT DISTINCT line_user_id FROM admin_broadcast_recipients WHERE broadcast_id = ANY($1::bigint[]) AND variant IN ('a', 'b', 'c') AND line_user_id IS NOT NULL",[ids]);
  return new Set(rows.rows.map(r=>r.line_user_id.trim().toLowerCase()));
}
function audienceRevision(rows) {
  return crypto.createHash('sha256').update(JSON.stringify([...new Set(rows.map(r=>r.line_user_id.trim().toLowerCase()))].sort())).digest('hex');
}
function signAudiencePreview({revision,conditions,selection}, secret, now=Date.now()) {
  if (!secret) throw new Error('audience_preview_signing_unavailable');
  const data=Buffer.from(JSON.stringify({revision,conditions,selection,expires:now+600000})).toString('base64url');
  return data+'.'+crypto.createHmac('sha256',secret).update(data).digest('base64url');
}
function verifyAudiencePreview(token, expected, secret, now=Date.now()) {
  if (!secret || typeof token!=='string' || token.length>100000) return false;
  const parts=token.split('.');if(parts.length!==2)return false;
  const signature=crypto.createHmac('sha256',secret).update(parts[0]).digest('base64url');
  if(parts[1].length!==signature.length || !crypto.timingSafeEqual(Buffer.from(parts[1]),Buffer.from(signature)))return false;
  try {const data=JSON.parse(Buffer.from(parts[0],'base64url').toString());return data.expires>now && data.revision===expected.revision && JSON.stringify(data.conditions)===JSON.stringify(expected.conditions) && JSON.stringify(data.selection)===JSON.stringify(expected.selection);}catch{return false;}
}
function sampleRecipients(rows, count, randomize=false) {
  const copy=rows.slice();
  if(randomize)for(let i=copy.length-1;i>0;i--){const j=crypto.randomInt(i+1);[copy[i],copy[j]]=[copy[j],copy[i]];}
  return copy.slice(0,count);
}
module.exports={normalizeExcludedBroadcastIds,loadExcludedTestRecipients,audienceRevision,signAudiencePreview,verifyAudiencePreview,sampleRecipients};
