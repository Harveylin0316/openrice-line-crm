// 訊息裡的按鈕：模板訊息、自訂 Flex 訊息都要包得住；自家頁面不包；多顆按鈕分得出來。
const path = require('path');
const M = require(path.join(__dirname, '..', 'src/core/messageTapTracking'));
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 跟線上那條「借電券」關鍵字回覆同形狀：按鈕是帶 action 的 box
const FLEX = { mode: 'flex_json', flex: { type: 'flex', altText: 'x', contents: { type: 'bubble',
  hero: { type: 'image', url: 'https://img.example.com/a.jpg' },
  body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: '標題' },
    { type: 'box', layout: 'vertical', action: { uri: 'https://example.com/promo', type: 'uri', label: '立即領取' }, contents: [] },
    { type: 'box', layout: 'vertical', contents: [
      { type: 'button', action: { uri: 'https://liff.line.me/abc/claim', type: 'uri', label: '自家領取頁' } },
      { type: 'button', action: { uri: 'https://example.com/more', type: 'uri', label: '看更多' } }
    ]},
    { type: 'button', action: { type: 'message', text: '我要問' } }
  ]}}}};
const TPL = { mode: 'template', template: { title: 'x', ctaLabel: '看優惠', ctaUrl: 'https://example.com/sale' } };

(async () => {
  // 1) 自訂 Flex：找得到每一顆對外的按鈕，自家頁面與「發送文字」的不算
  const list = M.listUriButtons(FLEX);
  ok(list.length === 2, '自訂訊息裡兩顆對外按鈕都找到了（找到 ' + list.length + ' 顆）');
  ok(list[0].label === '立即領取' && list[1].label === '看更多', '按鈕名稱抓得到，順序穩定');
  ok(!list.some(b => /liff\.line\.me/.test(b.uri)), '指向自家頁面的按鈕不列入（本來就認得出是誰）');

  // 2) 包成跳板：每顆各自的編號，原設定不會被改壞
  const before = JSON.stringify(FLEX);
  const wrapped = M.withMessageTracking(FLEX, { source: 'keyword', refId: '7', liffId: 'LID' });
  const w = M.listUriButtons(wrapped);
  ok(JSON.stringify(FLEX) === before, '原本的訊息設定完全沒被動到');
  const uris = [];
  (function walk(n) { if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.action && n.action.uri) uris.push(n.action.uri);
    Object.keys(n).forEach(k => { if (k !== 'action') walk(n[k]); }); })(wrapped);
  ok(uris.includes('https://liff.line.me/LID/t/m/keyword/7_0') &&
     uris.includes('https://liff.line.me/LID/t/m/keyword/7_1'), '兩顆各自有編號，分得出按的是哪一顆');
  ok(uris.includes('https://liff.line.me/abc/claim'), '自家頁面那顆維持原樣');

  // 3) 模板訊息也吃得下
  const tw = M.withMessageTracking(TPL, { source: 'keyword', refId: '3', liffId: 'LID' });
  ok(tw.template.ctaUrl === 'https://liff.line.me/LID/t/m/keyword/3_0', '模板訊息的按鈕也包得住');
  ok(TPL.template.ctaUrl === 'https://example.com/sale', '模板訊息的原設定沒被改壞');

  // 4) 反查：拿得回真正的目的地
  ok(M.findUriButton(FLEX, 1).uri === 'https://example.com/more', '反查第二顆拿到正確目的地');
  ok(M.findUriButton(FLEX, 9) === null, '不存在的按鈕編號回空的，不會亂給');

  // 5) 沒設 LIFF 就原樣返回——記不到人也不能把訊息弄壞
  ok(M.withMessageTracking(FLEX, { source: 'keyword', refId: '7', liffId: '' }) === FLEX,
     '沒設好 LIFF 時原樣送出，訊息照樣發得出去');

  // 6) 壞掉的設定不會炸
  ok(M.listUriButtons(null).length === 0 && M.listUriButtons('壞掉').length === 0, '亂七八糟的設定不會炸');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n訊息按鈕追蹤全部通過');
  process.exit(failed ? 1 : 0);
})();
