// Local UI harness: synthetic content only, no dotenv, no real send service.
const path=require('node:path'),express=require('express'),{Pool}=require('pg');
if(process.env.CRM_QA_ISOLATED!=='1')throw new Error('Local QA requires CRM_QA_ISOLATED=1');
process.env.APP_ENV='staging';process.env.SAFE_PREVIEW_MODE='1';
const pool=new Pool({host:'127.0.0.1',port:55439,user:'postgres',password:'STAGING-local-only',database:'postgres',options:'-c search_path=crm_staging'}),query=(s,p)=>pool.query(s,p);
const app=express();app.set('views',path.join(__dirname,'../../views'));app.set('view engine','ejs');app.use(express.json());app.use(express.static(path.join(__dirname,'../../public')));
app.use((req,res,next)=>{req.authUser={un:'STAGING LOCAL QA'};res.locals.appEnv='staging';res.locals.safePreviewMode=true;res.locals.isSafePreview=true;next();});
const authCore={requireAdmin:(req,res,next)=>next()};
const linePush={pushLineMessages:async()=>{throw new Error('QA forbids sends')}};
require('../../src/routes/adminWelcomeMessages').registerAdminWelcomeMessagesRoutes(app,{query,pool,authCore,linePush,resolvePublicSiteOrigin:()=> 'https://example.invalid'});
require('../../src/routes/adminMessagePerformance').registerAdminMessagePerformance(app,{query,authCore});
require('../../src/routes/adminPushLogs').registerAdminPushLogsRoutes(app,{query,authCore});
app.get('/admin/messages/api/list',async(req,res)=>res.json({ok:true,messages:(await query('SELECT * FROM admin_message_templates ORDER BY id')).rows}));
app.get('/admin/broadcast',(req,res)=>res.render('admin_broadcast',{title:'STAGING 本機群發驗證',bodyClass:'admin-shell broadcast-shell',user:'STAGING LOCAL QA',isAdmin:true,prizes:[],activities:[],recent:[],scheduled:[],running:[],hasLineToken:false,maxRecipients:5000,chunkSize:50,fieldLimits:{},msgLibMode:false,msgLibId:null,msgLibDup:false}));
app.post('/admin/broadcast/preview-message',(req,res)=>{const built=require('../../src/core/broadcastTemplates').buildLineMessages(req.body.message_config,{heroImageBaseUrl:'http://127.0.0.1:3099',recipientName:''});res.json(built.ok?{ok:true,channel:'line',messages:built.messages}:built)});
app.get('/admin/broadcast/exclusion-sources',(req,res)=>res.json({ok:true,sources:[{id:1,created_at:new Date().toISOString(),status:'awaiting_winner'}]}));
for(const route of ['/admin/recipient-lists/api/list','/admin/broadcast/test-recipients'])app.get(route,(req,res)=>res.json({ok:true,lists:[],recipients:[]}));
app.use((e,req,res,next)=>{console.error(e.message);res.status(500).json({ok:false,error:e.message})});
(async()=>{await query('CREATE TABLE IF NOT EXISTS admin_test_recipients(id bigint,label text,line_user_id text)');app.listen(3099,'127.0.0.1',()=>console.log('LOCAL_QA_READY'));})();
