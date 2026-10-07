const SOURCES=['welcome','broadcast','automation','keyword'];
function parsePerformanceFilters(raw={},now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const from=raw.from||today,to=raw.to||today;
 for(const d of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)throw new Error('日期格式不正確');
 if(to<from||Date.parse(to)-Date.parse(from)>366*86400000)throw new Error('一次最多查詢 366 天');
 if(raw.source&&!SOURCES.includes(raw.source))throw new Error('訊息來源不正確');
 if(raw.variant&&!['a','b','c'].includes(raw.variant))throw new Error('版本不正確');
 if(raw.revision && (!/^[1-9]\d{0,15}$/.test(String(raw.revision))||!Number.isSafeInteger(Number(raw.revision))))throw new Error('內容版本不正確');
 if(raw.sourceId&&!/^[1-9]\d{0,14}$/.test(String(raw.sourceId)))throw new Error('來源編號不正確');
 return {revision:raw.revision?Number(raw.revision):null,source:raw.source||null,sourceId:raw.sourceId?Number(raw.sourceId):null,variant:raw.variant||null,from:from+'T00:00:00+08:00',to:new Date(Date.parse(to)+86400000).toISOString().slice(0,10)+'T00:00:00+08:00'};
}
function metricRow(r){
 const tracked=r.tracked===true,people=r.people==null?null:Number(r.people),clickers=tracked&&r.clickers!=null?Number(r.clickers):null;
 return {...r,accepted:Number(r.accepted||0),rejected:Number(r.rejected||0),uncertain:Number(r.uncertain||0),pending:Number(r.pending||0),skipped:Number(r.skipped||0),triggerCount:r.triggers==null?null:Number(r.triggers),clickCount:tracked?Number(r.clicks||0):null,uniqueClickers:clickers,denominator:people,rate:tracked&&people>0&&clickers!=null?clickers/people:null,rateKind:'不重複點擊人數／API 接受發送人數',availabilityReason:!tracked?'尚未追蹤或沒有可追蹤連結':people===0?'尚無成功樣本':null};
}
function createMessagePerformance({query}){
 async function has(name){return !!(await query('SELECT to_regclass($1) AS name',[name])).rows[0]?.name;}
 async function summary(raw){const f=parsePerformanceFilters(raw),rows=[],coverage=[];
  if(await has('crm_message_executions')){
   const rs=await query(`SELECT e.source_type AS "sourceType",e.source_id AS "sourceId",e.revision,e.variant,
    COUNT(*)::int AS triggers,COUNT(*) FILTER(WHERE e.status='accepted')::int AS accepted,
    COUNT(*) FILTER(WHERE e.status='rejected')::int AS rejected,COUNT(*) FILTER(WHERE e.status IN ('uncertain','sending'))::int AS uncertain,COUNT(*) FILTER(WHERE e.status='pending')::int AS pending,
    COUNT(*) FILTER(WHERE e.status='skipped')::int AS skipped,
    COUNT(DISTINCT e.recipient_key) FILTER(WHERE e.status='accepted')::int AS people,
    COALESCE(SUM(c.clicks),0)::int AS clicks,COUNT(DISTINCT e.recipient_key) FILTER(WHERE c.clicks>0 AND e.status='accepted')::int AS clickers,
    BOOL_AND(e.targets <> '[]'::jsonb AND COALESCE((e.targets->0->>'tracked')::boolean,false)) FILTER(WHERE e.status='accepted') AS tracked
    FROM crm_message_executions e LEFT JOIN LATERAL(SELECT COUNT(*)::int clicks FROM crm_message_clicks c WHERE c.execution_id=e.id AND c.verified_identity=e.recipient_key AND c.occurred_at >= $1::timestamptz AND c.occurred_at < $2::timestamptz) c ON true
    WHERE e.source_type <> 'broadcast' AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz AND NOT e.test_only
      AND ($3::text IS NULL OR e.source_type=$3) AND ($4::bigint IS NULL OR e.source_id=$4) AND ($5::text IS NULL OR e.variant=$5) AND ($6::bigint IS NULL OR e.revision=$6)
    GROUP BY e.source_type,e.source_id,e.revision,e.variant ORDER BY e.source_type,e.source_id DESC,e.revision DESC LIMIT 201`,[f.from,f.to,f.source,f.sourceId,f.variant,f.revision]);
   rows.push(...rs.rows.map(metricRow));coverage.push('新執行紀錄：依觸發日期及同一查詢期間的點擊計算；不與關鍵字實驗觀察窗混算。');
  }else coverage.push('共用追蹤 migration 尚未套用；歡迎與新執行紀錄未啟用。');
  if(!f.revision&&(!f.source||f.source==='broadcast')){
   const rs=await query(`SELECT b.id AS "sourceId",r.variant,COUNT(*)::int triggers,
    COUNT(*) FILTER(WHERE r.status='sent')::int accepted,COUNT(*) FILTER(WHERE r.status='failed')::int rejected,
    COUNT(*) FILTER(WHERE r.status='skipped')::int skipped,COUNT(DISTINCT r.line_user_id) FILTER(WHERE r.status='sent')::int people,
    COALESCE(SUM(c.clicks),0)::int clicks,COUNT(DISTINCT r.line_user_id) FILTER(WHERE c.clicks>0 AND r.status='sent')::int clickers
    FROM admin_broadcasts b JOIN admin_broadcast_recipients r ON r.broadcast_id=b.id
    LEFT JOIN LATERAL(SELECT COUNT(*)::int clicks FROM admin_broadcast_clicks c WHERE c.broadcast_id=b.id AND c.recipient_id=r.id AND c.clicked_at >= $1::timestamptz AND c.clicked_at < $2::timestamptz) c ON true
    WHERE b.created_at >= $1::timestamptz AND b.created_at < $2::timestamptz AND COALESCE(b.channel,'line')='line'
    AND r.variant IN ('a','b','c') AND ($3::bigint IS NULL OR b.id=$3) AND ($4::text IS NULL OR r.variant=$4)
    GROUP BY b.id,r.variant ORDER BY b.id DESC LIMIT 201`,[f.from,f.to,f.sourceId,f.variant]);
   rows.push(...rs.rows.map(r=>({...metricRow({...r,sourceType:'broadcast',tracked:false}),clickCount:null,uniqueClickers:null,redirectCount:Number(r.clicks||0),clickedRecipientLinks:Number(r.clickers||0),availabilityReason:'群發舊追蹤未驗證點擊者身分；連結跳轉與被點擊的收件人連結數不等於有效點擊人數。CTR 請查看原批次報表',detailUrl:'/admin/broadcast/'+r.sourceId})));
  }
  if(!f.revision&&(!f.source||f.source==='keyword')&&await has('keyword_reply_experiments')){
   const rs=await query(`SELECT e.* FROM keyword_reply_experiments e WHERE e.start_at < $2::timestamptz AND e.end_at >= $1::timestamptz AND ($3::bigint IS NULL OR e.rule_id=$3) ORDER BY e.id DESC LIMIT 201`,[f.from,f.to,f.sourceId]);
   const {experimentReport}=require('./keywordExperiments');
   for(const experiment of rs.rows){
    const report=await experimentReport(query,experiment);
    for(const [variant,v] of Object.entries(report.variants)){
     if(f.variant&&f.variant!==variant)continue;
     rows.push({...metricRow({sourceType:'keyword',sourceId:experiment.rule_id,revision:'實驗 #'+experiment.id,variant,triggers:v.triggers,accepted:v.replies_ok,rejected:v.replies_failed,uncertain:v.replies_uncertain,people:v.matured_users,clickers:v.matured_clickers,clicks:v.target_clicks,tracked:v.trackable}),rateKind:'完成觀察的不重複點擊人數／完成觀察的回覆人數',availabilityReason:'獨立實驗：日期只篩選相交實驗；整個實驗的觸發／點擊次數，點擊率依首次成功後 '+report.attribution_days+' 天完成觀察樣本計算。',detailUrl:'/admin/keyword-replies'});
    }
   }
  }
  coverage.push('LINE API 接受不代表實際送達或已讀。舊流程／關鍵字紀錄缺乏快照時不回填，請由發送紀錄查原資料。');
  return {rows:rows.slice(0,200),truncated:rows.length>200,coverage,filters:f};
 }
 async function executions(raw){const f=parsePerformanceFilters(raw);if(!await has('crm_message_executions'))return {rows:[],unavailable:true};
  const before=raw.before?Number(raw.before):null;if(before!==null&&(!Number.isSafeInteger(before)||before<1))throw new Error('分頁資訊不正確');
  const rs=await query(`SELECT id,source_type,source_id,revision,variant,status,reason,created_at FROM crm_message_executions WHERE NOT test_only AND created_at >= $1::timestamptz AND created_at < $2::timestamptz AND ($3::text IS NULL OR source_type=$3) AND ($4::bigint IS NULL OR source_id=$4) AND ($5::text IS NULL OR variant=$5) AND ($6::bigint IS NULL OR id<$6) AND ($7::bigint IS NULL OR revision=$7) ORDER BY id DESC LIMIT 51`,[f.from,f.to,f.source,f.sourceId,f.variant,before,f.revision]);
  return {rows:rs.rows.slice(0,50),nextCursor:rs.rows.length>50?rs.rows[49].id:null};
 }
 async function details(id){if(!/^[1-9]\d{0,14}$/.test(String(id)))throw new Error('執行編號不正確');
  const rs=await query(`SELECT e.id,e.source_type,e.source_id,e.targets,e.revision,e.variant,e.status FROM crm_message_executions e WHERE id=$1 AND NOT test_only`,[id]);const e=rs.rows[0];if(!e)throw new Error('找不到執行紀錄');
  const counts=await query('SELECT action_index,COUNT(*)::int clicks,COUNT(DISTINCT verified_identity)::int people FROM crm_message_clicks WHERE execution_id=$1 GROUP BY action_index',[id]);
  return {...e,actions:e.targets.map(t=>({...t,...counts.rows.find(c=>Number(c.action_index)===t.index)}))};
 }
 return {summary,executions,details};
}
module.exports={parsePerformanceFilters,metricRow,createMessagePerformance};
