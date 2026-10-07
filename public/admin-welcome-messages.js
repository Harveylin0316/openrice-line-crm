(function(){
 const $=id=>document.getElementById(id);let settings=null,previewRevision=0;
 async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!d.ok)throw new Error(d.error==='migration_required'?'此功能需要先套用 Staging migration；目前未啟用。':d.error||'操作失敗');return d;}
 function status(s){$('welcome-status').textContent=s;}
 function show(s){settings=s;$('welcome-enabled').checked=!!s.enabled;$('welcome-first').checked=s.first_enabled;$('welcome-unblocked').checked=s.unblocked_enabled;if(s.message_id&&!Array.from($('welcome-message').options).some(o=>o.value===String(s.message_id))){$('welcome-message').add(new Option((s.message_name||'原素材已移除')+'（已儲存版本）',String(s.message_id)));}$('welcome-message').value=s.message_id||'';}
 Promise.all([api('/admin/welcome-messages/api'),api('/admin/messages/api/list')]).then(([data,library])=>{
  library.messages.filter(m=>(m.channel||'line')==='line').forEach(m=>$('welcome-message').add(new Option(m.name+' #'+m.id,String(m.id))));show(data.settings);
  $('welcome-flows').textContent=data.flows.length?'其他啟用中的加好友流程：'+data.flows.map(f=>f.name).join('、'):'未發現其他啟用中的加好友流程；仍需自行檢查 LINE 原生後台。';
  data.testers.forEach(t=>$('welcome-tester').add(new Option(t.label||('測試人員 #'+t.id),String(t.id))));
  $('welcome-fields').disabled=false;status('設定已載入；修改後請儲存。');
 }).catch(e=>status(e.message));
 $('welcome-form').addEventListener('submit',async e=>{e.preventDefault();$('welcome-fields').disabled=true;try{
  const data=await api('/admin/welcome-messages/api',{revision:Number(settings.revision),enabled:$('welcome-enabled').checked,firstEnabled:$('welcome-first').checked,unblockedEnabled:$('welcome-unblocked').checked,messageId:$('welcome-message').value,refreshSnapshot:$('welcome-refresh').checked,duplicateCheckConfirmed:$('welcome-duplicate').checked});show(data.settings);$('welcome-refresh').checked=false;status('已儲存。');
 }catch(e){status(e.message);}finally{$('welcome-fields').disabled=false;}});
 $('welcome-preview').addEventListener('click',async()=>{const revision=++previewRevision;try{const messageId=Number($('welcome-message').value);const useNew=messageId!==Number(settings.message_id)||$('welcome-refresh').checked;const data=await api('/admin/welcome-messages/preview',useNew?{messageId}:{saved:true});if(revision!==previewRevision)return;window.renderMessageSnapshot($('welcome-preview-content'),data.messages);status('預覽已更新（不計入成效）。');}catch(e){status(e.message);}});
 $('welcome-message').addEventListener('change',()=>{previewRevision++;$('welcome-preview-content').replaceChildren();});
 $('welcome-test').addEventListener('click',async()=>{if(!confirm('將已儲存歡迎訊息發給選定測試人員，確認？'))return;try{const d=await api('/admin/welcome-messages/test',{testRecipientId:Number($('welcome-tester').value)});status(d.skipped?'Staging 安全模式：未實際發送。':'LINE API 已接受測試發送。');}catch(e){status(e.message);}});
})();
