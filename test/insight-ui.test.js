// 數據總覽：日期選擇、曝光顯示與基本互動回歸。
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom 沒裝'); process.exit(0); }
const ejs = require('ejs');

const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }
function noopCtx() {
  const noop = () => {};
  return new Proxy({}, { get(_t, k) { return k === 'measureText' ? () => ({ width: 10 }) : noop; }, set() { return true; } });
}

(async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_insight.ejs'),
    { title: '數據總覽', bodyClass: 'admin-shell', user: 'admin', isAdmin: true },
    { views: [path.join(REPO, 'views')] });
  const calls = [];
  const data = {
    ok: true,
    days: 10,
    range: { from: '2026-09-01', to: '2026-09-10', days: 10, timezone: 'Asia/Taipei' },
    line: {
      followers: { followers: 2500, targetedReaches: 2300, blocks: 100 },
      demographic: { available: false },
      delivery: { apiPush: 12 },
      rich_menu: {
        available: true, total_impressions: 1100, metrics_from: '2026-09-01', metrics_to: '2026-09-10',
        partial: false, truncated: false,
        pages: [
          { menu_id: 3, menu_name: '主選單', tab: 1, is_default: true, status: 'ok', impressions: 800, unique_users: 500 },
          { menu_id: 3, menu_name: '主選單', tab: 2, is_default: true, status: 'ok', impressions: 300, unique_users: 200 }
        ]
      }
    },
    totals: { members: 2200, blocked: 100, joined_period: 40 },
    daily: [{ day: '09/01', joins: 2, blocks: 0, msgs: 3, menu_taps: 4, plays: 1 }],
    sources: [], activities: [],
    top_buttons: [
      { menu_id: 3, tab: 0, cell: 0, kind: 'link', label: 'STAGING 訂位', menu_name: '主選單', taps: 9, people: 5, identified_taps: 9 },
      { menu_id: 3, tab: 0, cell: 1, kind: 'link', label: 'STAGING 官網', menu_name: '主選單', taps: 7, people: 0, identified_taps: 0 },
      { menu_id: 3, tab: 0, cell: 2, kind: 'link', label: 'STAGING 活動', menu_name: '主選單', taps: 10, people: 2, identified_taps: 4 },
      { menu_id: 3, tab: 0, cell: 3, kind: 'message', label: 'STAGING 查訂位', menu_name: '主選單', taps: 6, people: 3, identified_taps: 6 }
    ],
    rich_menu_people: 8, rich_menu_anonymous_taps: 13
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://x/admin/insight?from=2026-09-01&to=2026-09-10',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => noopCtx();
      w.fetch = async url => { calls.push(String(url)); return { json: async () => data }; };
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve));
  await new Promise(resolve => setTimeout(resolve, 80));
  const doc = dom.window.document;

  ok(doc.getElementById('in-from').value === '2026-09-01' && doc.getElementById('in-to').value === '2026-09-10',
    '網址上的起訖日會帶入日期欄位');
  ok(/1,100/.test(doc.getElementById('in-richmenu').textContent) && /LINE 官方曝光次數/.test(doc.getElementById('in-richmenu').textContent),
    '圖文選單區會顯示 LINE 官方曝光總數');
  ok(/主選單/.test(doc.getElementById('in-richmenu').textContent) && /分頁 2/.test(doc.getElementById('in-richmenu').textContent),
    '每個圖文選單分頁的曝光可分開查看');
  ok(calls[0] && /from=2026-09-01&to=2026-09-10/.test(calls[0]), '初次載入依網址日期查詢');

  const before = calls.length;
  doc.getElementById('in-from').value = '2026-09-03';
  doc.getElementById('in-to').value = '2026-09-08';
  doc.getElementById('in-custom-apply').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  ok(calls.length === before + 1 && /from=2026-09-03&to=2026-09-08/.test(calls[calls.length - 1]),
    '按套用日期會以使用者選的起訖日重新查詢');

  const beforeBad = calls.length;
  doc.getElementById('in-from').value = '2026-09-08';
  doc.getElementById('in-to').value = '2026-09-03';
  doc.getElementById('in-custom-apply').click();
  ok(calls.length === beforeBad && /開始日不能晚於結束日/.test(doc.getElementById('in-note').textContent),
    '前端會擋下顛倒日期，不送錯誤查詢');

  // 圖文選單：點擊次數與不重複人數分開顯示
  const cellsOf = (name) => {
    const tr = [...doc.querySelectorAll('#in-buttons tbody tr')].find(x => x.textContent.indexOf(name) >= 0);
    return tr ? [...tr.children].map(td => td.textContent.trim()) : [];
  };
  ok(/不重複人數/.test(doc.querySelector('#in-buttons thead').textContent), '熱門按鍵表有「不重複人數」欄');
  ok(cellsOf('STAGING 訂位')[3] === '9' && cellsOf('STAGING 訂位')[4] === '5', '開啟網址有記身分：次數 9、不重複 5');
  ok(cellsOf('STAGING 官網')[4] === '—', '開啟網址沒記身分：不重複人數顯示「—」');
  ok(/^2/.test(cellsOf('STAGING 活動')[4]) && /另有 6 次未記錄身分/.test(cellsOf('STAGING 活動')[4]), '部分有記錄：顯示人數並註明');
  ok(cellsOf('STAGING 查訂位')[4] === '3', '發送文字按鍵顯示不重複人數');
  ok(/不重複點擊人數/.test(doc.getElementById('in-richmenu').textContent) && /另有 13 次點擊未記錄身分/.test(doc.getElementById('in-richmenu').textContent),
    '總覽顯示期間內不重複點擊人數與未記錄身分的點擊');
  const src = require('fs').readFileSync(path.join(REPO, 'src/routes/adminInsight.js'), 'utf8');
  ok(/AS identified_taps/.test(src) && /rich_menu_people/.test(src), 'API 回傳不重複人數所需欄位');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n數據總覽日期與曝光 UI 全部通過');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('爆掉:', err); process.exit(2); });
