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
    sources: [], top_buttons: [], activities: []
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

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n數據總覽日期與曝光 UI 全部通過');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('爆掉:', err); process.exit(2); });
