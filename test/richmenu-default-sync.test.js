'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncDefaultRichMenu } = require('../src/core/richMenuDefaultSync');
const { createLineRichMenuService } = require('../src/core/lineRichMenu');
const rows = [
  { id: 7, line_rich_menu_id: 'new', line_rich_menu_ids: [{id:'new-tab'}], audience_list_id: null, published_config: {default_sync_old_ids:['previous-publish','missing']} },
  { id: 5, line_rich_menu_id: 'old', line_rich_menu_ids: [{id:'old-tab'}], audience_list_id: null },
  { id: 3, line_rich_menu_id: 'segment', audience_list_id: 20 }
];
function setup(data=rows) {
  const calls=[];
  return {calls,query:async()=>({rows:data}),rm:{listRichMenus:async()=>['new','new-tab','old','old-tab','segment','previous-publish'].map(richMenuId=>({richMenuId})),replaceLinkedMenus:async(ids,target)=>{calls.push({ids,target});return {submitted:ids.length>0};}}};
}
test('換預設包含舊分頁及前次發布 ID，不碰當前分頁、分眾或不存在 ID',async()=>{
  const s=setup();await syncDefaultRichMenu({...s,targetId:'new',targetRowId:7,extraOldIds:['segment','old']});
  assert.deepEqual(s.calls,[{ids:['old','previous-publish','old-tab'],target:'new'}]);
});
test('未知外部選單或分眾選單不執行全員同步',async()=>{
  const s=setup();await syncDefaultRichMenu({...s,targetId:'external'});await syncDefaultRichMenu({...s,targetId:'segment',targetRowId:3});assert.equal(s.calls.length,0);
});
test('LINE 同步失敗不能假稱成功',async()=>{
  const s=setup();s.rm.replaceLinkedMenus=async()=>{throw Error('rate limited')};
  await assert.rejects(syncDefaultRichMenu({...s,targetId:'new',targetRowId:7}),/rate limited/);
});
test('LINE batch 僅精確替換指定舊選單，不使用 unlinkAll，空清單不呼叫',async()=>{
  const saved=global.fetch;const calls=[];
  global.fetch=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,text:async()=>'{}'};};
  try {
    const rm=createLineRichMenuService({channelAccessToken:'SYNTHETIC'});
    await rm.replaceLinkedMenus([], 'new');await rm.replaceLinkedMenus(['old','old','new'],'new');
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body.operations,[{type:'link',from:'old',to:'new'}]);
    assert.match(calls[0].body.resumeRequestKey,/^[\w-]+$/);
  } finally {global.fetch=saved;}
});
