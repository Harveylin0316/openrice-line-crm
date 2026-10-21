(function () {
  'use strict';
  var defaults = [{id:'basic',name:'一般回訪（內建）',subject:'再來 {{餐廳名稱}} 享受一頓好飯',preheader:'',body_text:'謝謝您先前到 {{餐廳名稱}} 用餐。\n\n最近想再聚一聚嗎？歡迎查看餐廳資訊，挑個方便的時間再來吃飯。\n\nOpenRice 台灣開飯喇'}];
  function expand(text,row) {
    return String(text || '').replace(/\{\{(餐廳名稱|客人姓名)\}\}/g,function(_,key){return key==='餐廳名稱'?row.restaurant_name:(row.recipient_name || '您好');});
  }
  function reusable(text,row) {
    // Replace exact known names only; never store To, CTA or unsubscribe tokens.
    var pairs = [[row.restaurant_name,'{{餐廳名稱}}'],[row.recipient_name,'{{客人姓名}}']].filter(function(p){return p[0]&&p[0].length>=2;}).sort(function(a,b){return b[0].length-a[0].length;});
    var result=String(text||'');pairs.forEach(function(p){result=result.split(p[0]).join(p[1]);});return result;
  }
  function mount(opts) {
    var root=opts.root,row=opts.row,doc=root.ownerDocument;
    var subject=root.querySelector('#rv-edit-subject'),body=root.querySelector('#rv-edit-body'),preheader=root.querySelector('#rv-edit-preheader'),cta=root.querySelector('#rv-edit-cta');
    if(!subject||!body)return;
    root.classList.add('rv-mail-editor');
    var envelope=doc.createElement('div');envelope.className='rv-mail-envelope';
    var from=doc.createElement('p');from.textContent='寄件人　sales@openrice.com.tw（請在 Spark／Outlook 確認帳號）';
    var to=doc.createElement('p');to.textContent='收件人　'+(row.recipient_name?row.recipient_name+' <'+row.recipient_email+'>':row.recipient_email);
    envelope.append(from,to);subject.closest('label').before(envelope);
    body.rows=12;body.placeholder='像寫 Email 一樣，在這裡輸入內文…';
    body.closest('label').firstChild.textContent='郵件內文';
    cta.closest('label').firstChild.textContent='訂位連結（這位客人的餐廳）';
    preheader.closest('label').hidden=true; // mailto does not support HTML preheaders.
    var oldPreview=root.querySelector('iframe.rv-preview');if(oldPreview)oldPreview.hidden=true;
    var live=doc.createElement('section');live.className='rv-mail-live';
    var heading=doc.createElement('h4');heading.textContent='客人會收到的純文字內容';
    var preview=doc.createElement('pre');preview.setAttribute('aria-live','polite');live.append(heading,preview);root.append(live);
    function update(){preview.textContent=subject.value.trim()+'\n\n'+(row.recipient_name?String(row.recipient_name).trim().slice(0,120)+'，你好':'你好')+'\n\n'+body.value.trim()+'\n\n查看餐廳並訂位：'+cta.value.trim()+'\n\n取消訂閱：[開啟草稿時自動加入這位客人的退訂連結]';}
    [subject,body,cta].forEach(function(el){el.addEventListener('input',update);});update();
    if(!opts.editable)return;
    var bar=doc.createElement('details');bar.className='rv-template-bar';
    bar.innerHTML='<summary>套用或管理郵件範本</summary><p>範本只保存主旨與內文，不保存收件人、訂位連結或寄送狀態。套用只改這封，按「儲存這封」才生效。</p><div class="rv-template-row"><select aria-label="選擇郵件範本"></select><button type="button" class="rv-btn rv-secondary" data-apply>套用範本</button></div><label class="rv-confirm"><input type="checkbox" data-replace><span>我同意以範本取代這封尚未儲存的主旨與內文</span></label><div class="rv-template-row"><input aria-label="新範本名稱" maxlength="80" placeholder="範本名稱，例如：一般回訪 10 月版"><button type="button" class="rv-btn rv-secondary" data-save>另存為新範本</button></div><p class="rv-template-msg" role="status"></p>';
    envelope.before(bar);
    var select=bar.querySelector('select'),name=bar.querySelector('input[aria-label]'),msg=bar.querySelector('[role=status]'),apply=bar.querySelector('[data-apply]'),save=bar.querySelector('[data-save]'),check=bar.querySelector('[data-replace]');
    var templates=defaults.slice(),busy=false;
    function connected(){return root.contains(bar)&&!subject.disabled;}
    function render(){select.replaceChildren();templates.forEach(function(t){var option=doc.createElement('option');option.value=String(t.id);option.textContent=t.name+(t.created_at?' · '+new Date(t.created_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'');select.append(option);});}
    render();
    opts.request('/admin/revisit-email/api/templates').then(function(d){if(!root.contains(bar))return;var selected=select.value,seen=new Set();templates=defaults.concat(templates.slice(defaults.length),d.templates||[]).filter(function(t){var key=String(t.id);if(seen.has(key))return false;seen.add(key);return true;});render();select.value=selected;}).catch(function(e){if(root.contains(bar))msg.textContent='已儲存的範本載入失敗：'+e.message+'。內建範本仍可使用。';});
    apply.addEventListener('click',function(){
      if(!connected()||busy)return;
      if(!check.checked){msg.textContent='請先勾選同意取代；原內容尚未變更。';return;}
      var template=templates.find(function(t){return String(t.id)===select.value;});if(!template)return;
      var content={subject:expand(template.subject,row),body:expand(template.body_text,row)};
      if(content.subject.length>200||content.body.length>4000){msg.textContent='代入姓名／餐廳後內容過長，請先縮短範本。';return;}
      subject.value=content.subject;body.value=content.body;preheader.value=template.preheader||'';check.checked=false;update();body.dispatchEvent(new Event('input',{bubbles:true}));
      msg.textContent='已套用到這封，訂位連結不變；請檢查優惠與日期，再按「儲存這封」。';
    });
    save.addEventListener('click',function(){
      if(!connected()||busy)return;
      if(!name.value.trim()||!subject.value.trim()||!body.value.trim()){msg.textContent='請填範本名稱、主旨與內文。';return;}
      busy=true;save.disabled=true;apply.disabled=true;
      opts.request('/admin/revisit-email/api/templates',{name:name.value,subject:reusable(subject.value,row),preheader:reusable(preheader.value,row),body_text:reusable(body.value,row)},'POST').then(function(d){
        if(!root.contains(bar))return;templates.splice(1,0,d.template);render();select.value=String(d.template.id);name.value='';msg.textContent='已儲存新範本，換電腦也能使用。姓名／餐廳已改為代入欄位；優惠內容與日期下次請再確認。這封信尚未儲存，也沒有寄出。';
      }).catch(function(e){if(root.contains(bar))msg.textContent='範本沒有儲存成功：'+e.message;}).finally(function(){busy=false;save.disabled=false;apply.disabled=false;});
    });
  }
  window.RevisitComposer={mount:mount,expand:expand,reusable:reusable};
})();
