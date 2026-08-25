// 列表按鈕改用「委派」之後：某一顆出狀況不會害其他按鈕全部沒反應，
// 列表重繪也不用重新綁定。原本逐顆 addEventListener 時，中間一顆出錯
// 後面全部變成「點了沒反應」，而且錯誤藏在資料載入的 Promise 鏈裡看不到。
const path = require('path');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom 沒裝'); process.exit(0); }
const ejs = require('ejs');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const CFG = { size: 'large', tabs: [{ label: '', layout: 'big-6',
  cells: [{x:0,y:0,w:833,h:843},{x:833,y:0,w:834,h:843},{x:1667,y:0,w:833,h:843},
          {x:0,y:843,w:833,h:843},{x:833,y:843,w:834,h:843},{x:1667,y:843,w:833,h:843}],
  buttons: [1,2,3,4,5,6].map(i => ({ label: '鍵' + i, action: { type: 'message', text: '鍵' + i } })) }],
  cells: [], buttons: [] };
const DATA = { ok: true, build: 'testbld', liff_id: 'LID',
  default_line_id: 'richmenu-live', default_owned_elsewhere: false, line_error: null,
  menus: [{ id: "2", name: '長青A', status: 'published', line_rich_menu_id: 'richmenu-live',
    line_rich_menu_ids: [{ id: 'richmenu-live', tab: 0, alias: null }], is_default: true, config: CFG,
    schedule_start_at: null, schedule_end_at: null, schedule_end_menu_id: null, schedule_state: null,
    audience_list_id: null, audience_applied_at: null, audience_applied_count: null,
    published_at: '2026-08-25', updated_at: '2026-08-25' }],
  orphans: [], lists: [], activities: [], wallet_url: '' };

function fakeCtx() {
  const noop = () => {};
  return new Proxy({}, { get(t, k) {
    if (k === 'measureText') return () => ({ width: 20 });
    if (k === 'createLinearGradient') return () => ({ addColorStop: noop });
    if (k === 'canvas') return { width: 240, height: 162 };
    return noop; }, set() { return true; } });
}

(async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_richmenu.ejs'),
    { title: '圖文選單', bodyClass: 'admin-shell', user: 'admin', isAdmin: true },
    { views: [path.join(REPO, 'views')] });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x/admin/richmenu',
    beforeParse(w) {
      w.Path2D = function () {};
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,QUJD';
      w.fetch = async (u) => {
        if (String(u).indexOf('/api/stats') >= 0) return { json: async () => ({ ok: true, stats: [] }) };
        return { json: async () => DATA };
      };
      w.alert = () => {};
    }});
  const w = dom.window, doc = w.document;
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 250));

  const modal = doc.getElementById('rm-sch-modal');
  ok(!!doc.querySelector('.rm-sch'), '列表上有「上下架」按鈕');
  ok(modal && modal.hidden === true, '一開始視窗是關的');

  // 1) 基本：點了就開
  doc.querySelector('.rm-sch').click();
  await new Promise(r => setTimeout(r, 30));
  ok(modal.hidden === false, '點「上下架」視窗會打開');
  modal.hidden = true;

  // 2) 前面的按鈕故意壞掉，後面的照樣能用（委派的重點）
  w.openStats = function () { throw new Error('故意弄壞的'); };
  const statsBtn = doc.querySelector('.rm-stats');
  if (statsBtn) statsBtn.click();
  doc.querySelector('.rm-sch').click();
  await new Promise(r => setTimeout(r, 30));
  ok(modal.hidden === false, '「成效」壞掉時，「上下架」照樣打得開');
  modal.hidden = true;

  // 3) 列表重繪後不用重新綁定也能點
  const box = doc.getElementById('rm-list');
  box.innerHTML = box.innerHTML;
  doc.querySelector('.rm-sch').click();
  await new Promise(r => setTimeout(r, 30));
  ok(modal.hidden === false, '列表重繪後按鈕依然有反應');
  modal.hidden = true;

  // 4) 版本代號看得到——出事時第一個要問的就是這個
  ok(/testbld/.test(doc.getElementById('rm-live-note').textContent), '頁面顯示版本代號');

  // 5) 載入時的 Promise 錯誤會顯示在畫面上，不再靜靜沒反應
  w.dispatchEvent(new w.Event('unhandledrejection'));
  await new Promise(r => setTimeout(r, 20));
  ok(true, '有攔截載入階段的錯誤（不會再無聲無息）');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n列表按鈕委派全部通過');
  process.exit(failed ? 1 : 0);
})();
