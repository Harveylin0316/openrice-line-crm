const SOURCES = Object.freeze({
  flow: '自動傳訊流程', flow_dryrun: '流程測試', admin_broadcast: '群發訊息',
  admin_broadcast_test: '群發測試', referral_inviter_notify: '成功邀請通知',
  winner_notification: '中獎通知', invite_progress_notification: '邀請進度通知',
  keyword_reply: '關鍵字回覆', admin_invite_reminder: '邀請提醒',
  admin_invite_reminder_test: '邀請提醒測試', leaderboard_test: '排行榜測試'
});
// Only an identical operation for the same recipient/source is recovery evidence.
// A different message sent to that person must never hide the failed attempt.
const RECOVERED_SQL = `(l.status = 'failed' AND NULLIF(l.payload->>'retryKey', '') IS NOT NULL AND EXISTS (
  SELECT 1 FROM line_push_logs s WHERE s.status = 'success'
  AND s.line_user_id = l.line_user_id AND s.push_type = l.push_type
  AND s.payload->>'retryKey' = l.payload->>'retryKey'
  AND (s.created_at, s.id) > (l.created_at, l.id)
))`;

function diagnosePush(row) {
  const detail = String(row.detail || '');
  const code = Number(row.http_status || 0);
  if (row.status === 'success') return { cause: 'LINE 已接受請求', action: '不需補發。這不是已讀或實際送達的證明。' };
  if (row.status === 'skipped') return { cause: '未送出：資料或設定不足', action: /token/i.test(detail) ? '請管理員檢查 LINE 串接設定；不要直接重發。' : '確認收件人 LINE 編號及訊息內容是否完整。' };
  if (code === 429 && /monthly limit/i.test(detail)) return { cause: 'LINE 回報本月訊息額度限制', action: '先到 LINE OA 後台檢查當月用量、方案與加購上限。這是當時的錯誤，不代表今天仍額度不足；確認恢復後再到原流程或群發紀錄處理。' };
  if (code === 429) return { cause: 'LINE 暫時限制發送速度', action: '先確認原流程是否仍在自動重試；不要同時另行補發。若持續發生，請管理員檢查發送頻率。' };
  if (code === 401 || code === 403) return { cause: 'LINE 授權或權限有問題', action: '請管理員檢查 Channel Access Token、官方帳號與 API 權限；修復後再確認原流程狀態。' };
  if (code === 409) return { cause: '重複請求：LINE 曾接受同一請求', action: '先核對原發送紀錄，不要再補發。LINE 去重不代表用戶已讀。' };
  if (code === 400 && /reply.?token/i.test(detail)) return { cause: '回覆憑證失效或已使用', action: '這次即時回覆無法原樣重送；請管理員檢查 Webhook 處理時間與重複回覆。' };
  if (code === 400 && /["']?to["']?.*(invalid|valid)|invalid.*["']to["']/i.test(detail)) return { cause: '收件人 LINE 編號不適用', action: '確認此編號屬於目前官方帳號／Provider。此錯誤不能單獨證明對方已封鎖。' };
  if (code === 400) return { cause: 'LINE 不接受這則訊息的格式', action: '回到原訊息檢查卡片、圖片／影片網址及 CTA，再寄給測試人員驗證；不要直接補發給客人。' };
  if (code >= 500 || !code) return { cause: '連線或服務異常，送達狀態待確認', action: '逾時不代表一定沒寄出。先查原流程與同一則後續紀錄，避免重複發送；請管理員確認再處理。' };
  return { cause: '發送失敗，需進一步確認', action: '展開 LINE 原始回應交給管理員，並確認原流程是否仍在重試；不要直接補發。' };
}

function messageSummary(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) return '舊紀錄未保存訊息內容';
  return messages.slice(0, 5).map((m, i) => {
    const text = m && (m.text || m.altText);
    const label = ({ text: '文字', flex: '卡片', image: '圖片', video: '影片', template: '卡片' })[m && m.type] || '訊息';
    const visible = [], seen = new Set();
    let visited = 0;
    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 25 || ++visited > 500) return;
      if (Array.isArray(node)) return node.forEach(v => walk(v, depth + 1));
      const line = node.type === 'text' ? node.text : node.type === 'button' && node.action ? node.action.label : '';
      if (typeof line === 'string' && line.trim() && !seen.has(line)) { visible.push(line.slice(0, 300)); seen.add(line); }
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
    }
    if (m && m.type === 'flex') walk(m.contents);
    return `${i + 1}. ${label}${text ? '：' + String(text).slice(0, 600) : ''}${visible.length ? '\n' + visible.slice(0, 12).join('\n').slice(0, 1200) : ''}`;
  }).join('\n');
}

function decoratePush(row) {
  const diagnosis = diagnosePush(row);
  const source = SOURCES[row.push_type] || row.push_type || '其他來源';
  const sourceName = row.flow_name || (row.broadcast_id ? `群發批次 #${row.broadcast_id}` : row.activity_name);
  const material = row.payload && row.payload.messageName;
  const sourceHref = row.broadcast_id ? `/admin/broadcast/${row.broadcast_id}` : row.flow_id ? '/admin/flows' : '';
  return { ...row, ...diagnosis, source: (sourceName ? `${source} · ${sourceName}` : source) + (typeof material === 'string' && material ? ` · ${material.slice(0, 200)}` : ''),
    sourceHref, message: messageSummary(row.payload),
    action: row.status === 'failed' && row.recovered ? '同一則後續已被 LINE 接受，不需另行補發。這仍不是已讀或實際送達的證明。' : diagnosis.action,
    person: row.line_display_name || row.username || '未找到 CRM 名稱（以 LINE 編號核對）',
    followUp: row.recovered ? '同一則後續已被 LINE 接受，不需另行補發。' :
      row.flow_status === 'active' ? '原流程仍在執行；請先查看流程狀態，不要另外補發。' :
      row.flow_status === 'failed' ? '原流程已停止重試。先排除原因，再到「自動傳訊」查看並處理。' :
      '此紀錄無法確認是否已補送；請先核對原發送紀錄。' };
}

function taipeiTime(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)).replace(/\s+/g, ' ');
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

module.exports = { SOURCES, RECOVERED_SQL, diagnosePush, messageSummary, decoratePush, taipeiTime, csvCell };
