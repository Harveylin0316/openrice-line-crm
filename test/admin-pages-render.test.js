// 每個後台頁面都要「用它的路由實際傳的參數」渲染得出來。
// 這支測試會自己去讀路由：res.render('xxx', { ... }) 裡列了哪些變數就傳哪些，
// 所以「路由查了資料卻忘了傳給頁面」這種漏洞會直接被抓到
// （群發頁就是這樣壞掉的：prizes 和 recent 查了沒傳，整頁 500，兩個多月沒人發現）。
const fs = require('fs'), path = require('path'), ejs = require('ejs'), vm = require('vm');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 1) 從路由抽出每個頁面實際傳的變數名
const routeFiles = fs.readdirSync(path.join(REPO, 'src/routes')).filter(f => f.endsWith('.js'));
const params = {};
for (const f of routeFiles) {
  const src = fs.readFileSync(path.join(REPO, 'src/routes', f), 'utf8');
  const re = /res\.render\(\s*'([a-z_]+)'\s*,\s*\{([\s\S]{0,1200}?)\n\s*\}\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const view = m[1];
    // 兩種寫法都要抓：「key: value」與簡寫的「key,」
    const body = m[2].replace(/\/\/[^\n]*/g, '');
    const keys = [
      ...[...body.matchAll(/(?:^|[,{\n])\s*([a-zA-Z_][\w]*)\s*:/g)].map(x => x[1]),
      ...[...body.matchAll(/(?:^|[,{\n])\s*([a-zA-Z_][\w]*)\s*(?=,|\s*$)/gm)].map(x => x[1])
    ];
    if (!params[view]) params[view] = new Set();
    keys.forEach(k => params[view].add(k));
  }
}

// 2) 依變數名給形狀合理的假值
function fake(k) {
  const known = {
    title: '測試', bodyClass: 'admin-shell', user: 'admin', isAdmin: true, currentUid: 1,
    activityId: 7, gameTypes: ['wheel','claim'], statuses: ['draft','active','paused','ended'],
    prizeTypes: ['coupon_code','none'],
    activity: { id: 7, slug: 'x', name: '測試活動', status: 'active', game_type: 'wheel' },
    prize: { id: 1, name: '獎品', quantity: 5 },
    prizes: [{ id: 1, name: 'Rice Dollars $100', quantity: 10 }],
    broadcast: { id: 1, status: 'sent', message_config: {}, audience_config: {},
                 recipient_total: 10, recipient_ok: 9, recipient_fail: 1, recipient_skip: 0 },
    list: { id: 1, name: '名單', total: 3, created_at: new Date().toISOString() },
    clickStat: { clicks: 0, unique_ua: 0 }, viewStat: { views: 0, first_view: null, last_view: null },
    abStat: null, hasLineToken: true, maxRecipients: 20000, chunkSize: 50,
    fieldLimits: { title: 40, subtitle: 120, ctaLabel: 40, ctaUrl: 1000, couponCode: 40, disclaimer: 200, altText: 400 },
    inviteLimit: 8, inviteFriendsPerDraw: 2, defaultDomain: 'openrice.com',
    error: null, notice: null, message: null, page: 1, totalCount: 0,
    hasPrevPage: false, hasNextPage: false, authDegraded: false
  };
  if (k in known) return known[k];
  if (/^(is|has|can|show)/.test(k)) return false;
  if (/(count|total|limit|num|page|size)$/i.test(k)) return 0;
  if (/s$/.test(k)) return [];
  return '';
}

// 3) 逐頁渲染
const views = Object.keys(params).filter(v => v.startsWith('admin_')).sort();
ok(views.length >= 30, '抓得到後台頁面的參數（' + views.length + ' 頁）');

(async () => {
  for (const v of views) {
    const file = path.join(REPO, 'views', v + '.ejs');
    if (!fs.existsSync(file)) { ok(false, v + '：找不到樣板檔'); continue; }
    const data = {};
    params[v].forEach(k => { data[k] = fake(k); });
    try {
      const html = await ejs.renderFile(file, data, { views: [path.join(REPO, 'views')] });
      ok(html.length > 300, v + ' 渲染得出來');
      // 渲染成功還不夠：頁面裡的 JavaScript 也要真的能執行。
      // 語法錯一個字，整段 script 一行都不跑，頁面看起來正常卻永遠停在「載入中」
      // （用戶檔案頁就這樣壞掉——刪舊功能時留下一個多餘的 }); ）
      // 只檢查真的會被當程式碼跑的 script：
      // 外部檔案（src=）與放資料用的（type="application/json" 那種）不算
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(m => !/\ssrc=/i.test(m[1]))
        .filter(m => {
          const t = /type\s*=\s*["']([^"']+)["']/i.exec(m[1]);
          return !t || /javascript|module/i.test(t[1]);
        })
        .map(m => m[2]);
      const bad = [];
      scripts.forEach((code, i) => {
        if (!code.trim()) return;
        try { new vm.Script(code); } catch (e) { bad.push('第' + (i + 1) + '段：' + e.message); }
      });
      ok(bad.length === 0, v + ' 的頁面程式碼沒有語法錯誤' + (bad.length ? ('（' + bad[0] + '）') : ''));
    } catch (e) {
      ok(false, v + ' 渲染失敗：' + String(e.message).split('\n').slice(-1)[0].slice(0, 70));
    }
  }
  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n所有後台頁面都渲染得出來');
  process.exit(failed ? 1 : 0);
})();
