'use strict';
// Synthetic UI fixture, localhost only. No DB, real email or customer data.
if(process.env.CRM_QA_ISOLATED!=='1')throw Error('CRM_QA_ISOLATED=1 required');
const express=require('express');
const app=express();app.set('views',process.cwd()+'/views');app.set('view engine','ejs');app.use(express.json());app.use(express.static('public'));
const rows=[1,2,3,4,5,6].map(id=>({id,recipient_name:'測試客人'+id,recipient_email:'qa'+id+'@example.com',restaurant_name:'示範餐廳'+id,subject:'一起再來示範餐廳'+id+'吃頓好飯',preheader:'',body_copy:'謝謝您先前到示範餐廳'+id+'用餐。\n\n最近想再聚一聚嗎？歡迎查看餐廳資訊，挑個方便的時間再來吃飯。\n\nOpenRice 台灣開飯喇',cta_url:'https://example.com/book/'+id,status:id===1?'needs_review':id===6?'sent':'pending',failure_detail:id===1?'outlook_draft_requested':null}));
const campaign={id:1,status:'draft',as_of_date:'2026-10-21',candidate_count:24,settings_snapshot:{booking_source:'示範訂位名單（虛構資料）'},excluded_counts:{not_due:8,unsubscribed:2,restaurant_cooldown:8}};
app.get('/admin/revisit-email',(q,r)=>r.render('admin_revisit_email',{user:'Synthetic QA',isAdmin:true,isOwner:q.query.staff!=='1',bodyClass:'admin-shell revisit-email-shell'}));
app.get('/admin/revisit-email/api/data',(q,r)=>r.json({ok:true,settings:{},stats:{bookings:100,eligible_source_bookings:75,active_offers:3,sent:1,clicked:0},booking_source:{id:1,accepted_count:100,source_file:'示範訂位名單'},sender:{},booking_report:{configured:true,status_available:true,latest_booking_date:'2026-10-20'},campaigns:[{...campaign,pending:rows.filter(r=>r.status==='pending').length,needs_review:rows.filter(r=>r.status==='needs_review').length,sent:rows.filter(r=>r.status==='sent').length}],imports:[],suppressions:[]}));
app.get('/admin/revisit-email/api/campaigns/1',(q,r)=>r.json({ok:true,campaign,recipients:rows}));
app.get('/admin/revisit-email/api/templates',(q,r)=>r.json({ok:true,templates:[]}));
app.get('/admin/revisit-email/api/recipients/:id/preview',(q,r)=>r.send('Synthetic preview only'));
app.put('/admin/revisit-email/api/recipients/:id',(q,r)=>{const row=rows.find(x=>x.id===Number(q.params.id));Object.assign(row,{subject:q.body.subject,preheader:q.body.preheader,body_copy:q.body.body_text,cta_url:q.body.cta_url});r.json({ok:true});});
app.post('/admin/revisit-email/api/recipients/:id/outlook-draft',(q,r)=>{const row=rows.find(x=>x.id===Number(q.params.id));row.status='needs_review';row.failure_detail='outlook_draft_requested';campaign.status='sending';r.json({ok:true,draft:{email:row.recipient_email,subject:row.subject,body:row.body_copy+'\n\n查看餐廳並訂位：'+row.cta_url+'\n\n取消訂閱：https://example.com/unsubscribe',mailto:null}});});
app.post('/admin/revisit-email/api/recipients/:id/review',(q,r)=>{const row=rows.find(x=>x.id===Number(q.params.id));row.status=q.body.action==='confirm_sent'?'sent':q.body.action==='cancel'?'cancelled':'pending';r.json({ok:true});});
app.use((q,r)=>r.status(400).json({ok:false,detail:'Synthetic QA: action not supported; nothing sent'}));
app.listen(3127,'127.0.0.1',()=>console.log('Synthetic revisit UI: http://127.0.0.1:3127/admin/revisit-email — no real sending'));
