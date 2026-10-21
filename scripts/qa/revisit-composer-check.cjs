'use strict';
// Own isolated DB and local web server only. Never sends email or opens mailto.
const {Pool}=require('pg'),fs=require('node:fs'),assert=require('node:assert/strict'),express=require('express');
const {registerRevisitMailTemplates}=require('../../src/routes/revisitMailTemplates');
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('Isolated local QA required');
(async()=>{
 const config={host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres'};
 const admin=new Pool(config),name='revisit_composer_'+Date.now();await admin.query('CREATE DATABASE '+name);
 const pool=new Pool({...config,database:name});let server,browser;
 const migration=fs.readFileSync('supabase/migrations/20261012124908_revisit_mail_templates.sql','utf8'),rollback=fs.readFileSync('supabase/rollbacks/20261012124908_revisit_mail_templates.sql','utf8');
 try{
  await pool.query(migration);await pool.query(migration);await pool.query(rollback);await pool.query(migration);
  assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='revisit_email_templates'")).rows[0].relrowsecurity,true);
  const app=express();app.set('view engine','ejs');app.set('views',process.cwd()+'/views');app.use(express.json());app.use(express.static('public'));app.use((req,res,next)=>{req.authUser={un:'Synthetic QA'};next();});
  registerRevisitMailTemplates(app,{query:(...args)=>pool.query(...args),requireAdmin:(q,r,n)=>n(),requireOwner:(q,r,n)=>n()});
  const campaign={id:1,status:'draft',as_of_date:'2026-10-12',settings_snapshot:{},excluded_counts:{}};
  const recipients=[1,2].map(id=>({id,restaurant_name:'虛構餐廳'+id,recipient_name:'測試客人'+id,recipient_email:'qa'+id+'@example.com',subject:'歡迎來虛構餐廳'+id,preheader:'',body_copy:'謝謝測試客人'+id+'到虛構餐廳'+id+'用餐。',cta_url:'https://example.com/book/'+id,status:'pending'}));
  app.get('/admin/revisit-email',(q,r)=>r.render('admin_revisit_email',{user:'Synthetic QA',isAdmin:true,isOwner:true,bodyClass:'admin-shell revisit-email-shell'}));
  app.get('/admin/revisit-email/api/data',(q,r)=>r.json({ok:true,settings:{},stats:{},sender:{},campaigns:[{...campaign,pending:2}],imports:[],suppressions:[],booking_report:{}}));
  app.get('/admin/revisit-email/api/campaigns/1',(q,r)=>r.json({ok:true,campaign,recipients}));
  app.get('/admin/revisit-email/api/recipients/:id/preview',(q,r)=>r.send('Synthetic HTML preview'));
  app.put('/admin/revisit-email/api/recipients/:id',(q,r)=>{const row=recipients.find(x=>x.id===Number(q.params.id));Object.assign(row,{subject:q.body.subject,body_copy:q.body.body_text,preheader:q.body.preheader,cta_url:q.body.cta_url});r.json({ok:true});});
  server=await new Promise(resolve=>{const s=app.listen(3121,'127.0.0.1',()=>resolve(s));});
  const {chromium}=require('playwright');browser=await chromium.launch({headless:true,...(process.env.CRM_QA_BROWSER_CHANNEL?{channel:process.env.CRM_QA_BROWSER_CHANNEL}:{})});
  for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:3121/admin/revisit-email');await page.getByRole('button',{name:'檢查並寄送',exact:true}).click();await page.getByText('套用或管理郵件範本',{exact:true}).click();await page.locator('[data-save]').waitFor();
   assert.equal(await page.locator('#rv-edit-preheader').isVisible(),false);
   await page.getByLabel('新範本名稱').fill('QA 範本 '+width);await page.locator('[data-save]').click();await page.getByText('已儲存新範本，換電腦也能使用。',{exact:false}).waitFor();
   await page.locator('#rv-edit-body').fill('未儲存的新內文');await page.locator('[data-open="2"]').click();assert.equal(await page.locator('#rv-edit-body').inputValue(),'未儲存的新內文');
   await page.getByRole('button',{name:'放棄未儲存內容並切換'}).click();await page.getByText('套用或管理郵件範本',{exact:true}).click();await page.getByLabel('選擇郵件範本').locator('option').filter({hasText:'QA 範本 '+width}).waitFor({state:'attached'});await page.getByLabel('選擇郵件範本').selectOption({label:(await page.locator('select[aria-label="選擇郵件範本"] option').allTextContents()).find(x=>x.startsWith('QA 範本 '+width))});
   await page.locator('[data-replace]').check();await page.locator('[data-apply]').click();assert.equal(await page.locator('#rv-edit-body').inputValue(),'謝謝測試客人2到虛構餐廳2用餐。');assert.equal(await page.locator('#rv-edit-cta').inputValue(),'https://example.com/book/2');
   await page.locator('#rv-save-copy').click();await page.getByText('已儲存；可準備郵件草稿。若使用本機直接寄送，需重新寄測試信。',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
   await page.locator('#rv-editor').screenshot({path:'/tmp/revisit-composer-'+width+'.png'});
   await page.reload();await page.getByRole('button',{name:'檢查並寄送',exact:true}).click();await page.getByLabel('選擇郵件範本').locator('option').filter({hasText:'QA 範本 '+width}).waitFor({state:'attached'});
   console.log('PASS '+width+'px: real SQL save/reload, dynamic names, CTA retained, dirty switch blocked, save selected, no overflow/page errors');await page.close();
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM revisit_email_templates')).rows[0].n,2);
  await assert.rejects(pool.query(rollback),/Saved templates exist/);console.log('PASS real PG: idempotent migration, empty rollback, RLS, nonempty rollback preserves templates');
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
