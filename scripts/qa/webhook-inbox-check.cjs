'use strict';
const {Pool}=require('pg');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {createReceiver,createDrain,signature}=require('../../src/core/lineWebhookInbox');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Requires isolated QA');
(async()=>{
 const pool=new Pool({host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres'});
 const client=await pool.connect();const schema='webhook_qa_'+Date.now();
 try{
  await client.query('BEGIN');await client.query('CREATE SCHEMA '+schema);await client.query('SET LOCAL search_path TO '+schema);
  const sql=fs.readFileSync('supabase/migrations/20261012091804_line_webhook_inbox.sql','utf8').replace("IF current_schema() NOT IN ('public','crm_staging')", "IF current_schema() NOT IN ('public','crm_staging','"+schema+"')");
  await client.query(sql);await client.query(sql);
  const query=(s,p)=>client.query(s,p);
  const body=JSON.stringify({events:[{webhookEventId:'QA1',type:'message'}]});
  const receive=createReceiver({query,channelSecret:'QA'});
  const e={httpMethod:'POST',body,headers:{'x-line-signature':signature(body,'QA')}};
  assert.equal((await receive(e)).statusCode,200);assert.equal((await receive(e)).statusCode,200);
  assert.equal((await query('SELECT * FROM line_webhook_inbox')).rowCount,1);
  let processed=0;const drain=createDrain({query,processEvent:async()=>{processed++;return true;}});
  await drain();await receive(e);await drain();assert.equal(processed,1);
  assert.equal((await query('SELECT status FROM line_webhook_inbox')).rows[0].status,'done');
  console.log('PASS migration repeat, receiver duplicate, worker drain, duplicate after done');
 }finally{await client.query('ROLLBACK');client.release();await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
