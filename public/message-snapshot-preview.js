(function(){
 const sizes={xxs:'10px',xs:'12px',sm:'14px',md:'16px',lg:'18px',xl:'20px',xxl:'24px',none:'0px'};
 const size=v=>sizes[v]||(/^\d+(?:\.\d+)?(?:px|%)$/.test(v||'')?v:'8px');
 const uri=u=>/^https?:\/\//i.test(u||'')&&!/\/(?:r\/b|v\/b|rf|t\/[mxe])\//.test(u);
 function text(s){const e=document.createElement('div');e.textContent=s||'';e.style.whiteSpace='pre-wrap';e.style.overflowWrap='anywhere';return e;}
 function image(u){if(!uri(u))return text('圖片預覽未提供或為追蹤資源');const e=document.createElement('img');e.src=u;e.alt='訊息圖片';e.style.width='100%';e.style.height='auto';return e;}
 function node(n){if(!n)return text('');
  if(n.type==='image')return image(n.url);
  if(n.type==='text'||n.type==='span'){const e=text(n.text||(n.contents||[]).map(c=>c.text||'').join(''));if(n.color)e.style.color=n.color;if(n.size)e.style.fontSize=size(n.size);if(n.weight==='bold')e.style.fontWeight='700';if(n.align)e.style.textAlign=n.align;return e;}
  if(n.type==='button'){const e=text(n.action?.label||'按鈕');e.style.cssText+=';padding:12px;text-align:center;background:#fff4c4;border-radius:8px';return e;}
  const e=document.createElement('div');e.style.minWidth='0';e.style.maxWidth='100%';
  if(n.type==='box'){e.style.display='flex';e.style.flexDirection=n.layout==='horizontal'||n.layout==='baseline'?'row':'column';e.style.gap=size(n.spacing||'none');if(n.backgroundColor)e.style.backgroundColor=n.backgroundColor;if(n.paddingAll)e.style.padding=size(n.paddingAll);if(n.cornerRadius)e.style.borderRadius=size(n.cornerRadius);}
  if(n.type==='carousel'){e.style.display='grid';e.style.gap='12px';}
  if(n.type==='bubble'){e.style.background='#fff';e.style.border='1px solid #ddd';e.style.borderRadius='12px';e.style.overflow='hidden';['header','hero','body','footer'].forEach(k=>{if(n[k])e.appendChild(node(n[k]));});}
  else (n.contents||[]).forEach(c=>e.appendChild(node(c)));
  return e;
 }
 window.renderMessageSnapshot=function(container,messages){container.replaceChildren();(messages||[]).forEach((m,i)=>{
  const section=document.createElement('section');section.style.cssText='margin:12px 0;min-width:0;max-width:100%;overflow:hidden';section.appendChild(text('第 '+(i+1)+' 段'));
  if(m.type==='text')section.appendChild(text(m.text));
  else if(m.type==='flex')section.appendChild(node(m.contents));
  else if(m.type==='image')section.appendChild(image(m.previewImageUrl||m.originalContentUrl));
  else if(m.type==='video'){section.appendChild(image(m.previewImageUrl));section.appendChild(text('▶ 影片（預覽不播放）'));}
  else if(m.type==='imagemap'){
   const map=document.createElement('div');map.style.position='relative';map.appendChild(image(m.baseUrl+'/1040'));
   (m.actions||[]).forEach((a,j)=>{const area=a.area;if(!area||!m.baseSize)return;const box=text(String(j+1));box.style.cssText='position:absolute;border:1px dashed #d99c00;pointer-events:none;background:#fff3';box.style.left=(area.x/m.baseSize.width*100)+'%';box.style.top=(area.y/m.baseSize.height*100)+'%';box.style.width=(area.width/m.baseSize.width*100)+'%';box.style.height=(area.height/m.baseSize.height*100)+'%';map.appendChild(box);});section.appendChild(map);
   (m.actions||[]).forEach((a,j)=>section.appendChild(text((j+1)+'. '+(a.type==='uri'?a.linkUri:'傳送文字：'+a.text))));
  }else section.appendChild(text('此類型請使用 LINE 指定測試人員驗證'));
  container.appendChild(section);
 });};
})();
