'use strict';
// Isolated PostgreSQL engine, synthetic identities, no dotenv/network/LINE sends.
// NODE_PATH=/private/tmp/crm-liff-qa/node_modules node scripts/qa/broadcast-direct-liff-db.cjs
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {createDirectLiffHitHandler}=require('../../src/routes/broadcastDirectLiff');
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE TABLE admin_broadcasts(id bigint PRIMARY KEY, channel text, is_ab_test boolean, message_config jsonb, variant_b_message_config jsonb, audience_config jsonb);
 CREATE TABLE admin_broadcast_recipients(id bigint PRIMARY KEY, broadcast_id bigint, line_user_id text, status text, variant text, first_clicked_at timestamptz);
 CREATE TABLE admin_broadcast_clicks(id bigserial PRIMARY KEY,broadcast_id bigint,recipient_id bigint,line_user_id text,target_url text,user_agent text,variant text,button_index int,referer text,clicked_at timestamptz DEFAULT now());
 CREATE UNIQUE INDEX uq_broadcast_clicks_recipient ON admin_broadcast_clicks(broadcast_id,recipient_id,target_url) WHERE recipient_id IS NOT NULL;`);
 const id='1234567890-Abcd',uid='U'+'1'.repeat(32);
 const cfg={mode:'template',template:{title:'QA',subtitle:'QA',ctaLabel:'Open',ctaUrl:'https://liff.line.me/'+id,altText:'QA'}};
 await db.query('INSERT INTO admin_broadcasts VALUES(91,$1,false,$2,NULL,$3)',['line',cfg,{}]);
 await db.query('INSERT INTO admin_broadcast_recipients VALUES(92,91,$1,$2,$3,NULL)',[uid,'sent','a']);
 // PGlite has one connection: serialize pool checkout, not individual queries.
 // Verifies actual SQL/idempotency, not native multi-connection lock contention.
 let queue=Promise.resolve();
 const pool={async connect(){const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return {query:(...args)=>db.query(...args),release}}};
 const handler=createDirectLiffHitHandler({pool,env:{BROADCAST_DIRECT_LIFF_APPS:JSON.stringify({[id]:'https://activity.example/index.html'})},verifyToken:async()=>({ok:true,sub:uid,aud:'1234567890'})});
 async function hit(reference='91.92.0.-'){
  const req={body:{reference,liff_id:id,id_token:'synthetic',page_path:'/index.html'},get:k=>k==='origin'?'https://activity.example':'QA',query:{}};
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(data){this.data=data;return this}};
  await handler(req,res);return res;
 }
 const results=await Promise.all(Array.from({length:5},()=>hit()));
 assert.ok(results.every(r=>r.statusCode===200),JSON.stringify(results));
 assert.equal(results.filter(r=>r.data.recorded).length,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM admin_broadcast_clicks')).rows[0].n,1);
 assert.ok((await db.query('SELECT first_clicked_at FROM admin_broadcast_recipients')).rows[0].first_clicked_at);
 assert.equal((await hit('91.92.0.b')).statusCode,403);
 // The existing schema dedupes per destination URL, even across two buttons.
 const flex={mode:'flex_json',flex:{type:'flex',altText:'QA',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[0,1].map(()=>({type:'button',action:{type:'uri',label:'QA',uri:cfg.template.ctaUrl}}))}}}};
 await db.query('UPDATE admin_broadcasts SET message_config=$1',[flex]);
 const second=await hit('91.92.1.-');assert.equal(second.statusCode,200,'same URL on second button must dedupe, not 503');assert.equal(second.data.recorded,false);
 await db.exec('UPDATE admin_broadcast_clicks SET button_index=NULL,variant=NULL');
 const legacy=await hit();assert.equal(legacy.statusCode,200,'legacy URL-level record must not break direct tracking');assert.equal(legacy.data.recorded,false);
 assert.equal((await db.query('SELECT count(*)::int n FROM admin_broadcast_clicks')).rows[0].n,1);
 await db.exec('TRUNCATE admin_broadcast_clicks; UPDATE admin_broadcast_recipients SET first_clicked_at=NULL; ALTER TABLE admin_broadcast_clicks ADD CONSTRAINT reject_write CHECK(false)');
 assert.equal((await hit()).statusCode,503);
 assert.equal((await db.query('SELECT first_clicked_at FROM admin_broadcast_recipients')).rows[0].first_clicked_at,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM admin_broadcast_clicks')).rows[0].n,0);
 await db.close();console.log('PASS PostgreSQL SQL: five queued requests -> one click; timestamp updated; wrong variant rejected; failed insert rolls back timestamp');
})().catch(err=>{console.error(err);process.exitCode=1});
