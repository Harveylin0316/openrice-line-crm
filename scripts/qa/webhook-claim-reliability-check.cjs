'use strict';
// Only a fresh localhost QA database; never load .env or contact LINE.
const {Pool}=require('pg');
const fs=require('node:fs'),assert=require('node:assert/strict');
const {CLAIM_SQL,createClaim,createDrain}=require('../../src/core/lineWebhookInbox');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Requires CRM_QA_ISOLATED=1');
(async()=>{
 const conn={host:'127.0.0.1',port:55439,user:'postgres',database:'postgres'};
 const admin=new Pool(conn),name='webhook_claim_qa_'+Date.now();let pool;
 try{
  await admin.query('CREATE DATABASE '+name);pool=new Pool({...conn,database:name,max:12});
  await pool.query(fs.readFileSync('supabase/migrations/20261012091804_line_webhook_inbox.sql','utf8'));
  const seed=async(n=1)=>{for(let u=0;u<n;u++)for(let i=0;i<2;i++)await pool.query('INSERT INTO line_webhook_inbox(event_id,payload) VALUES($1,$2)',['QA-'+u+'-'+i,JSON.stringify({events:[{webhookEventId:'QA-'+u+'-'+i,source:{userId:'QA-user-'+u}}]})]);};
  await seed();
  // Reproduce the old race deterministically: first claim holds its row lock
  // uncommitted; second snapshot misses processing status, then the existing
  // unique index safely rejects it. The improvement avoids this worker failure.
  const a=await pool.connect();try{
   await a.query('BEGIN');const first=await a.query(CLAIM_SQL);
   const secondTask=pool.query(CLAIM_SQL).then(r=>({result:r}),error=>({error}));
   await new Promise(r=>setTimeout(r,50));await a.query('COMMIT');
   const second=await secondTask;assert.equal(first.rowCount,1);assert.equal(second.error?.code,'23505');
  }finally{await a.query('ROLLBACK');a.release();}
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM line_webhook_inbox WHERE status='processing'")).rows[0].n,1);
  console.log('REPRODUCED old claim: overlapping snapshots hit unique index (no duplicate processing)');
  await pool.query('TRUNCATE line_webhook_inbox');await seed();
  const a2=await pool.connect();
  const claim=createClaim({query:(s,p)=>pool.query(s,p)});
  try {
   await a2.query('BEGIN');const first=await a2.query(CLAIM_SQL);
   const second=claim();await new Promise(r=>setTimeout(r,50));await a2.query('COMMIT');
   assert.equal(first.rowCount,1);assert.equal((await second).rows.length,0);
  }finally{await a2.query('ROLLBACK');a2.release();}
  console.log('PASS new claim recovers collision with a fresh snapshot; no worker failure');
  await pool.query('TRUNCATE line_webhook_inbox');await seed(6);
  const active=new Map(),maxPerUser=new Map(),seen=new Set();let concurrent=0,maxConcurrent=0;
  const drain=createDrain({query:(s,p)=>pool.query(s,p),claim,processEvent:async p=>{
   const e=p.events[0],u=e.source.userId;assert.equal(seen.has(e.webhookEventId),false);seen.add(e.webhookEventId);
   active.set(u,(active.get(u)||0)+1);maxPerUser.set(u,Math.max(maxPerUser.get(u)||0,active.get(u)));concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
   await new Promise(r=>setTimeout(r,35));active.set(u,active.get(u)-1);concurrent--;return true;
  }});
  await Promise.all(Array.from({length:5},()=>drain()));await drain();
  assert.equal(seen.size,12);assert.ok([...maxPerUser.values()].every(n=>n===1));assert.ok(maxConcurrent>1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM line_webhook_inbox WHERE status='done'")).rows[0].n,12);
  console.log('PASS 5 workers / 12 events: same-user serial, different-user parallel, each event once');
  const {createRuntime}=require('../../src/core/lineWebhookInboxRuntime');
  const runtimePools=[];class QaPool extends Pool {constructor(config){super(config);runtimePools.push(this);}}
  const env={DATABASE_URL:'postgres://postgres@127.0.0.1:55439/'+name,PG_SSL_DISABLED:'1'};
  try{
   await assert.rejects(createRuntime({env,PoolClass:QaPool}).query('SELECT pg_sleep(1)'));
   await createRuntime({env,PoolClass:QaPool,worker:true}).query('SELECT pg_sleep(1)');
   console.log('PASS one-second DB latency: HTTP remains bounded, background tolerates normal delay');
  }finally{await Promise.all(runtimePools.map(p=>p.end()));}

 }finally{if(pool)await pool.end();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
