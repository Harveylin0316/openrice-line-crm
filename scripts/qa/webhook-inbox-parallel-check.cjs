'use strict';
const {Pool}=require('pg');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {createReceiver,createDrain,signature}=require('../../src/core/lineWebhookInbox');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Requires isolated QA');
(async()=>{
 const conn={host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres'};
 const admin=new Pool(conn);const name='webhook_parallel_'+Date.now();
 await admin.query('CREATE DATABASE '+name);const pool=new Pool({...conn,database:name,max:10});
 try {
  const sql=fs.readFileSync('supabase/migrations/20261012091804_line_webhook_inbox.sql','utf8');await pool.query(sql);await pool.query(sql);
  const query=(s,p)=>pool.query(s,p);const receiver=createReceiver({query,channelSecret:'QA'});
  const send=async events=>{const body=JSON.stringify({events});return receiver({httpMethod:'POST',body,headers:{'x-line-signature':signature(body,'QA')}});};
  const events=[{webhookEventId:'QA-1',type:'qa',source:{userId:'QA-user'}},{webhookEventId:'QA-2',type:'qa',source:{userId:'QA-user'}}];
  await Promise.all(Array.from({length:10},()=>send(events)));assert.equal((await query('SELECT * FROM line_webhook_inbox')).rowCount,2);
  let active=0,max=0;const seen=[];
  const drain=createDrain({query,processEvent:async p=>{active++;max=Math.max(max,active);seen.push(p.events[0].webhookEventId);await new Promise(r=>setTimeout(r,50));active--;return true;}});
  await Promise.allSettled(Array.from({length:5},()=>drain()));await drain();
  assert.equal(max,1);assert.deepEqual(seen,['QA-1','QA-2']);
  console.log('PASS 10 duplicate batches / 5 workers: one process per event, same-user serial order');
  await query("INSERT INTO line_webhook_inbox(event_id,payload,status,started_at) VALUES('QA-stale','{}','processing',now()-interval '21 min')");await drain();
  assert.equal((await query("SELECT status FROM line_webhook_inbox WHERE event_id='QA-stale'")).rows[0].status,'uncertain');
  await assert.rejects(query(fs.readFileSync('supabase/rollbacks/20261012091804_line_webhook_inbox_rollback.sql','utf8')),/Inbox contains events/);
  console.log('PASS interrupted processing is uncertain; nonempty rollback refused');
 }finally{await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
