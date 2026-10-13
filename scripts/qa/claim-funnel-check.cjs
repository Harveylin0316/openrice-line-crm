'use strict';
// Dedicated local synthetic DB. No remote credentials, customer records or sends.
const {Pool}=require('pg'),assert=require('node:assert/strict'),express=require('express');
const {loadClaimFunnel}=require('../../src/core/claimFunnel');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Requires isolated localhost QA');
(async()=>{
 const config={host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres'};
 const admin=new Pool(config),name='claim_funnel_'+Date.now();await admin.query('CREATE DATABASE '+name);
 const pool=new Pool({...config,database:name});let browser,server;
 try{
  await pool.query(`CREATE TABLE activity_user_events(activity_id int,line_user_id text,event_name text,created_at timestamptz);
   CREATE TABLE activity_plays(activity_id int,line_user_id text,played_at timestamptz,coupon_code text,prize_snapshot jsonb,properties jsonb);
   CREATE TABLE users(line_user_id text,created_at timestamptz);
   INSERT INTO activity_user_events VALUES
    (7,'synthetic-a','enter','2020-09-30 12:00+08'),(7,'synthetic-a','copy_code','2020-10-02 12:00+08'),(7,'synthetic-a','redeem_click','2020-10-02 12:01+08'),
    (7,'synthetic-b','enter','2020-09-20 12:00+08'),
    (8,'synthetic-c','enter','2020-09-01 11:00+08'),(9,'synthetic-d','enter','2020-09-01 12:00+08');
   INSERT INTO activity_plays VALUES
    (7,'synthetic-a','2020-09-30 12:01+08','QA-A','{}','{}'),(7,'synthetic-a','2020-09-30 12:02+08','QA-A','{}','{}'),
    (7,'synthetic-b','2020-09-01 12:00+08','QA-B','{}','{}'),
    (8,'synthetic-c','2020-09-01 12:00+08','QA-C','{}','{}'),(9,'synthetic-d','2020-09-01 12:00+08','QA-D','{}','{}'),
    (10,'synthetic-e','2020-09-01 12:00+08','QA-E','{"kind":"draw_win"}','{}'),
    (11,'synthetic-f',now()-interval '1 hour','QA-F','{}','{}');`);
  const run=(id,opts={})=>loadClaimFunnel(pool.query.bind(pool),id,{windowDays:7,...opts});
  const cross=await run(7,{from:'2020-09-30',to:'2020-09-30'});
  assert.equal(cross.all.opened,1);assert.equal(cross.all.copied,1);assert.equal(cross.all.redeemed,1);assert.equal(cross.all.inferred_open,0);assert.equal(cross.observation.to_exclusive,'2020-10-07T04:00:00.000Z');
  const inferred=await run(7,{from:'2020-09-01',to:'2020-09-01'});assert.equal(inferred.all.opened,1);assert.equal(inferred.all.inferred_open,1);
  assert.equal((await run(8)).all.inferred_open,0);assert.equal((await run(9)).all.inferred_open,0);assert.equal((await run(10)).all.cohort_total,0);
  const immature=await run(11);assert.equal(immature.all.cohort_total,1);assert.equal(immature.all.opened,0);assert.equal(immature.all.inferred_open,0);assert.equal(immature.observation,null);
  console.log('PASS real PG: cross-date copy/redeem, earliest inferred source despite later enter, direct-enter ties, draw exclusion, duplicate dedup, immature exclusion');
  if(process.env.CRM_QA_BROWSER==='1'){
   const app=express();app.set('view engine','ejs');app.set('views',process.cwd()+'/views');app.use(express.static('public'));
   app.get('/qa',(q,r)=>r.render('admin_activity_players',{title:'Synthetic QA',user:'Synthetic QA',isAdmin:true,bodyClass:'admin-shell',activity:{id:7,name:'虛構領券活動',game_type:'claim',base_plays_per_user:1,referral_bonus_per:1,referral_bonus_max:3}}));
   app.get('/admin/activities/api/7/testers',(q,r)=>r.json({ok:true,testers:[]}));
   app.get('/admin/activities/api/7/players',(q,r)=>r.json({ok:true,players:[],overview:{},funnel:null,grants:null,play_distribution:[],claim_funnel:cross}));
   server=await new Promise(resolve=>{const s=app.listen(3122,'127.0.0.1',()=>resolve(s));});
   const {chromium}=require('playwright');browser=await chromium.launch({headless:true,...(process.env.CRM_QA_BROWSER_CHANNEL?{channel:process.env.CRM_QA_BROWSER_CHANNEL}:{})});
   for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:3122/qa');const row=page.locator('#claim-table tbody tr').filter({hasText:'複製序號'});await row.waitFor();
    assert.equal((await row.locator('td').nth(1).textContent()).startsWith('1'),true);assert.match(await row.textContent(),/部分觀察期未記錄/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    await page.locator('#claim-funnel-card').screenshot({path:'/tmp/pr46-claim-'+width+'.png'});await page.close();console.log('PASS browser '+width+'px: valid count visible, partial coverage warning, no overflow/page errors');
   }
  }
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
