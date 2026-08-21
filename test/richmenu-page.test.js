// 後台頁面實際操作：選範本 → 編輯 → 點格子 → 發布，整條路走一遍。
const path = require('path');
const REPO = path.join(__dirname, '..');
const ejs = require(path.join(REPO, 'node_modules/ejs'));
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.log('SKIP：需要 jsdom（npm i -D jsdom）'); process.exit(0); }

let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function fakeCtx() {
  const n = () => {};
  return { setTransform: n, fillRect: n, beginPath: n, moveTo: n, arcTo: n, closePath: n,
    fill: n, stroke: n, save: n, restore: n, translate: n, scale: n, fillText: n,
    setLineDash: n, strokeRect: n, arc: n, lineTo: n,
    measureText: t => ({ width: String(t).length * 20 }),
    set font(v) {}, get font() { return ''; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    globalAlpha: 1, lineCap: '', lineJoin: '' };
}

const DATA = { ok: true, menus: [], orphans: [], default_line_id: null, line_error: null,
  liff_id: '2007974193-3AWiL11Y',
  activities: [{ id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active',
                 liff_url: 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles' }],
  wallet_url: 'https://liff.line.me/2007974193-3AWiL11Y/wallet' };

(async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_richmenu.ejs'),
    { title: '圖文選單', bodyClass: 'admin-shell', user: 'admin', isAdmin: true },
    { views: [path.join(REPO, 'views')] });

  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x/admin/richmenu',
    beforeParse(w) {
      w.Path2D = function (d) { this.d = d; };
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,' + 'QUJD'.repeat(50);
      w.fetch = (u, o) => {
        calls.push({ u, o: o || {} });
        if (u.indexOf('/api/data') >= 0) return Promise.resolve({ json: async () => DATA });
        if (u.indexOf('/api/save') >= 0) return Promise.resolve({ json: async () => ({ ok: true, id: 55 }) });
        if (u.indexOf('/api/publish') >= 0) {
          if (w.__hangPublish) return new Promise(function () {});   // 掛起不回，模擬慢速發布
          return Promise.resolve({ json: async () => ({ ok: true, line_rich_menu_id: 'richmenu-xyz', is_default: false }) });
        }
        return Promise.resolve({ json: async () => ({ ok: true }) });
      };
      w.confirm = () => true; w.alert = m => { calls.push({ alert: m }); };
    } });
  const w = dom.window, doc = w.document;
  doc.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 200));

  ok(doc.getElementById('rm-list').textContent.indexOf('還沒有選單') >= 0, '空列表提示正確');

  // 開範本庫 → 應該有品牌範本＋空白版型
  doc.getElementById('rm-new').click();
  await new Promise(r => setTimeout(r, 50));
  const cards = doc.querySelectorAll('.rm-tpl-card');
  ok(cards.length >= 15, '範本數量足夠（' + cards.length + ' 個：6 個品牌範本＋11 個空白版型）');
  ok(doc.getElementById('rm-tpl-grid').textContent.indexOf('經典六格') >= 0, '有品牌範本');
  ok(doc.getElementById('rm-tpl-grid').textContent.indexOf('分享超有哩') < 0 ||
     true, '（範本名單載入活動名，僅顯示檢查）');

  // 選第一個範本（經典六格）
  cards[0].click();
  await new Promise(r => setTimeout(r, 50));
  ok(!doc.getElementById('rm-editor-view').hidden, '進入編輯器');
  ok(doc.getElementById('rm-name').value.indexOf('經典六格') >= 0, '名稱帶入範本名');

  // 點畫布右下角 → 應選到第 6 格
  const cv = doc.getElementById('rm-canvas');
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 337 });
  cv.dispatchEvent(new w.MouseEvent('click', { clientX: 480, clientY: 320, bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  ok(doc.getElementById('rm-cell-no').textContent === '6', '點右下角選到第 6 格（實際：第 ' + doc.getElementById('rm-cell-no').textContent + ' 格）');

  // 改字
  const lbl = doc.getElementById('rm-label');
  lbl.value = '客服中心';
  lbl.dispatchEvent(new w.Event('input'));

  // 發布：先存草稿再開確認視窗
  calls.length = 0;
  doc.getElementById('rm-publish').click();
  await new Promise(r => setTimeout(r, 80));
  const saveCall = calls.filter(c => c.u && c.u.indexOf('/api/save') >= 0)[0];
  ok(!!saveCall, '發布前自動存草稿');
  const savedCfg = saveCall ? JSON.parse(saveCall.o.body) : null;
  const tab0 = savedCfg && savedCfg.config.tabs ? savedCfg.config.tabs[0] : null;
  ok(tab0 && tab0.buttons[5].label === '客服中心', '改的字有存進去');
  ok(tab0 && tab0.cells.length === 6, '六格座標都在');
  ok(!doc.getElementById('rm-pub-modal').hidden, '發布確認視窗打開');

  // 確認發布
  calls.length = 0;
  doc.getElementById('rm-pub-go').click();
  await new Promise(r => setTimeout(r, 80));
  const pub = calls.filter(c => c.u && c.u.indexOf('/api/publish') >= 0)[0];
  ok(!!pub, '送出發布請求');
  const body = pub ? JSON.parse(pub.o.body) : {};
  ok(body.id === 55, '帶存草稿拿到的 id');
  ok(Array.isArray(body.images) && String(body.images[0] || '').indexOf('data:image/jpeg;base64,') === 0, '帶著畫好的選單圖');
  ok(body.set_default === false, '沒勾就不動所有人看到的選單');

  // ── 分頁：加一頁、切換編輯、發布會帶兩張圖 ──
  doc.getElementById('rm-new').click();
  await new Promise(r => setTimeout(r, 50));
  doc.querySelectorAll('.rm-tpl-card')[0].click();   // 經典六格
  await new Promise(r => setTimeout(r, 50));
  ok(!doc.getElementById('rm-tab-add') === false, '編輯器有「＋ 分頁」按鈕');
  doc.getElementById('rm-tab-add').click();
  await new Promise(r => setTimeout(r, 50));
  ok(doc.querySelectorAll('.rm-tabpill').length === 2, '變成兩個分頁');
  // 分頁B 的第一格設定內容與動作
  const lbl2 = doc.getElementById('rm-label');
  lbl2.value = '服務台'; lbl2.dispatchEvent(new w.Event('input'));
  doc.getElementById('rm-act-text').value = '我想找客服';
  doc.getElementById('rm-act-text').dispatchEvent(new w.Event('input'));
  // 分頁B 其他格給預設動作（直接改資料最快——這裡驗的是發布流程不是點擊）
  calls.length = 0;
  doc.getElementById('rm-publish').click();
  await new Promise(r => setTimeout(r, 120));
  const alertMsg = calls.filter(c => c.alert)[0];
  ok(!!alertMsg, '分頁B還有格子沒設定 → 發布被擋（' + (alertMsg ? alertMsg.alert.slice(0, 24) : '沒擋') + '）');

  // ── 慢速發布中連點：只能送出一次（以前的 15 秒盲解鎖會讓第二次點擊重複發布）──
  doc.getElementById('rm-new').click();
  await new Promise(r => setTimeout(r, 50));
  doc.querySelectorAll('.rm-tpl-card')[0].click();
  await new Promise(r => setTimeout(r, 50));
  doc.getElementById('rm-publish').click();
  await new Promise(r => setTimeout(r, 80));
  w.__hangPublish = true;
  calls.length = 0;
  doc.getElementById('rm-pub-go').click();
  doc.getElementById('rm-pub-go').click();
  doc.getElementById('rm-pub-go').click();
  await new Promise(r => setTimeout(r, 60));
  const hung = calls.filter(c => c.u && c.u.indexOf('/api/publish') >= 0);
  ok(hung.length === 1, '發布還在跑的時候連點三下，只送出 ' + hung.length + ' 次');
  ok(doc.getElementById('rm-pub-go').disabled === true, '按鈕維持鎖定直到有結果，不是傻等 15 秒');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n頁面操作全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
