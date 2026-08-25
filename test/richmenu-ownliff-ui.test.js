// 編輯器對「開啟網址」按鍵的三種情況要講不同的話，而且判準要跟後端一致：
//   自家活動頁 → 鎖住勾選框並說明改用別的規則抓
//   合作夥伴的活動頁（同樣是 liff.line.me，但不是我們的編號）→ 當成外部，可以勾
//   一般外部網址 → 可以勾
// 這支同時守住「這頁不可以用正規表示式」——之前那行 regex 讓整個面板每次都丟錯。
const path = require('path');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom 沒裝'); process.exit(0); }
const ejs = require('ejs');
const REPO = path.join(__dirname, '..');
const { isOwnLiff } = require(path.join(REPO, 'src/core/messageTapTracking'));
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const OWN = '2007974193-AAAA';          // 自家預設編號
const ACT = '2007974193-BBBB';          // 某個活動自訂的編號
const PARTNER = '9999999999-PARTNER';   // 合作夥伴的

const CFG = { size: 'large', tabs: [{ label: '', layout: 'big-6',
  cells: [0,1,2,3].map(i => ({ x: i * 600, y: 0, w: 600, h: 1686 })),
  buttons: [
    { label: '自家活動頁', action: { type: 'uri', uri: 'https://liff.line.me/' + OWN + '/wheel/x' } },
    { label: '活動自訂編號', action: { type: 'uri', uri: 'https://liff.line.me/' + ACT + '/claim/y' } },
    { label: '夥伴活動頁', action: { type: 'uri', uri: 'https://liff.line.me/' + PARTNER + '/page' } },
    { label: '一般網址', action: { type: 'uri', uri: 'https://www.openrice.com/tw' } }
  ] }], cells: [], buttons: [] };

const DATA = { ok: true, build: 'test', liff_id: OWN,
  default_line_id: null, default_owned_elsewhere: false, line_error: null,
  menus: [{ id: "1", name: '測試選單', status: 'draft', line_rich_menu_id: null, line_rich_menu_ids: null,
    is_default: false, config: CFG, schedule_start_at: null, schedule_end_at: null,
    schedule_end_menu_id: null, schedule_state: null, audience_list_id: null,
    audience_applied_at: null, audience_applied_count: null, published_at: null, updated_at: '2026-08-25' }],
  orphans: [], lists: [],
  activities: [{ id: 9, slug: 'claim-x', name: '領券活動', game_type: 'claim', status: 'active',
                 liff_url: 'https://liff.line.me/' + ACT + '/claim/claim-x' }],
  wallet_url: '' };

function fakeCtx() { const noop = () => {};
  return new Proxy({}, { get(t, k) {
    if (k === 'measureText') return () => ({ width: 20 });
    if (k === 'createLinearGradient') return () => ({ addColorStop: noop });
    if (k === 'canvas') return { width: 240, height: 162 };
    return noop; }, set() { return true; } }); }

(async () => {
  // 後端的判準
  process.env.GAMES_LIFF_ID = OWN;
  ok(isOwnLiff('https://liff.line.me/' + OWN + '/x'), '後端：自家編號算自家');
  ok(isOwnLiff('https://liff.line.me/' + ACT + '/y', [ACT]), '後端：活動自訂的編號也算自家');
  ok(!isOwnLiff('https://liff.line.me/' + PARTNER + '/z'), '後端：合作夥伴的不算自家');

  const html = await ejs.renderFile(path.join(REPO, 'views/admin_richmenu.ejs'),
    { title: '圖文選單', bodyClass: 'admin-shell', user: 'admin', isAdmin: true },
    { views: [path.join(REPO, 'views')] });
  const errs = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x/admin/richmenu',
    beforeParse(w) {
      w.Path2D = function () {};
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,QUJD';
      w.fetch = async () => ({ json: async () => DATA });
      w.alert = () => {}; w.confirm = () => true;
      w.onerror = (m) => errs.push(String(m));
      w.addEventListener('unhandledrejection', e => errs.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
    }});
  const w = dom.window, doc = w.document;
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 250));

  doc.querySelector('.rm-edit').click();
  await new Promise(r => setTimeout(r, 200));

  const idc = doc.getElementById('rm-act-identify');
  const hint = doc.getElementById('rm-act-idhint');
  ok(!!idc && !!hint, '編輯器有「記錄是誰點的」這個設定');

  // 選格子的方式跟真實頁面一致：點畫布上該格的位置（頁面用座標換算出是第幾格）
  const canvas = doc.getElementById('rm-canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 337 });
  const pickCell = (i) => {
    const c = CFG.tabs[0].cells[i];
    if (!c) return false;
    // 格子中心點 → 換算回畫布上的像素
    const px = ((c.x + c.w / 2) / 2500) * 500;
    const py = ((c.y + c.h / 2) / 1686) * 337;
    const ev = new w.MouseEvent('click', { bubbles: true, clientX: px, clientY: py });
    canvas.dispatchEvent(ev);
    return true;
  };

  const expect = [
    { i: 0, name: '自家活動頁',   鎖住: true,  說明含: '本來就知道是誰' },
    { i: 1, name: '活動自訂編號', 鎖住: true,  說明含: '本來就知道是誰' },
    { i: 2, name: '夥伴活動頁',   鎖住: false, 說明含: '不勾' },
    { i: 3, name: '一般網址',     鎖住: false, 說明含: '不勾' }
  ];
  let checked = 0;
  for (const e of expect) {
    if (!pickCell(e.i)) break;
    await new Promise(r => setTimeout(r, 60));
    const uriBtn = [].find.call(doc.querySelectorAll('.rm-actbtn'), b => b.getAttribute('data-mode') === 'uri');
    if (uriBtn) uriBtn.click();
    await new Promise(r => setTimeout(r, 60));
    ok(idc.disabled === e.鎖住, e.name + '：勾選框' + (e.鎖住 ? '鎖住' : '可以勾'));
    ok(hint.textContent.indexOf(e.說明含) >= 0,
       e.name + '：說明講對了（' + hint.textContent.replace(/\s+/g, '').slice(0, 22) + '…）');
    checked++;
  }
  ok(checked === expect.length, '四種情況都檢查到了（實際 ' + checked + '/4）');
  ok(errs.length === 0, '整個過程沒有丟出任何錯誤' + (errs.length ? ('：' + errs[0]) : ''));

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n自家活動頁的判斷前後端一致');
  process.exit(failed ? 1 : 0);
})();
