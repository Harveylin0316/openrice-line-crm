// 旅電領券頁的文案，同事要能自己在後台改，而且不能改壞旁邊的設定
// （兌換網址、效期那些跟文案存在同一份資料裡）。
const path = require('path');
const { registerAdminHubRoutes } = require(path.join(__dirname, '..', 'src/routes/adminHub'));
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const ORIGINAL = {
  page_title: '1 小時免費借電券',
  claimed_title: '你的借電券已準備好',
  tagline: '手機有電，美食不斷線',
  how_to_claim: ['點擊領取', '複製序號', '前往兌換'],
  tnc: ['效期至 2026/12/31'],
  // 這些不是文案，存檔時絕對不能被洗掉
  redeem_url: 'https://c.lvelect.com:444/#/DownloadApp',
  redeem_url_ios: 'https://reurl.cc/o17LW3',
  redeem_url_android: 'https://reurl.cc/k1Xdmq',
  use_expires_on: '2026-12-31',
  hero_image: '/images/ludian-hero.jpg',
  partner: '旅電科技'
};

function build() {
  const routes = {}; const writes = [];
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
  let stored = JSON.parse(JSON.stringify(ORIGINAL));
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    if (/SELECT p.id, p.prize_value FROM activity_prizes/.test(f))
      return { rows: [{ id: 23, prize_value: stored }] };
    if (/UPDATE activity_prizes SET prize_value/.test(f)) {
      stored = JSON.parse(params[1]); writes.push(stored); return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
  const pass = (rq, rs, nx) => nx();
  registerAdminHubRoutes(app, { query, pool: { query },
    authCore: { requireAdmin: pass, requireOwner: pass } });
  return { routes, writes, getStored: () => stored };
}
function mkRes() { const o = { code: 200, body: null };
  o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
  o.render = (v, d) => { o.rendered = v; o.locals = d; return o; }; return o; }
async function run(routes, key, body) {
  const hs = routes[key]; if (!hs) throw new Error('沒有這個路由：' + key);
  const r = mkRes();
  const req = { body: body || {}, query: {}, params: {}, headers: {}, authUser: { un: 'a', adm: true }, get: () => '' };
  for (let i = 0; i < hs.length; i++) {
    let called = false; await hs[i](req, r, () => { called = true; }); if (!called) break;
  }
  return r;
}

(async () => {
  // 1) 讀得出現有文案，清單變成一行一項
  let t = build();
  let r = await run(t.routes, 'GET /admin/campaigns/ludian/api/copy');
  ok(r.body.ok && r.body.values.claimed_title === '你的借電券已準備好', '讀得出「領完之後的大標題」');
  ok(r.body.values.how_to_claim === '點擊領取\n複製序號\n前往兌換', '清單顯示成一行一項');
  ok(r.body.fields.length >= 8 && r.body.fields.every(f => f.label && f.hint),
     '每個欄位都有看得懂的名稱與說明');
  ok(!r.body.fields.some(f => /[a-z_]{4,}/.test(f.label)), '欄位名稱是人話，不是代號');

  // 2) 改文案
  t = build();
  r = await run(t.routes, 'POST /admin/campaigns/ludian/api/copy',
    { claimed_title: '你的借電券來了', how_to_claim: '第一步\n第二步\n' });
  ok(r.body.ok, '存得起來');
  const after = t.getStored();
  ok(after.claimed_title === '你的借電券來了', '大標題改掉了');
  ok(Array.isArray(after.how_to_claim) && after.how_to_claim.length === 2, '空白行不會變成空項目');

  // 3) 最重要：不能洗掉旁邊的設定
  ok(after.redeem_url === ORIGINAL.redeem_url &&
     after.redeem_url_ios === ORIGINAL.redeem_url_ios &&
     after.redeem_url_android === ORIGINAL.redeem_url_android &&
     after.use_expires_on === ORIGINAL.use_expires_on &&
     after.hero_image === ORIGINAL.hero_image,
     '兌換網址、效期、圖片都原封不動（跟文案存在同一份資料裡）');
  ok(after.tagline === ORIGINAL.tagline, '這次沒改的文案欄位也維持原樣');

  // 4) 清空欄位＝把那段拿掉，不是留一個空字串
  t = build();
  await run(t.routes, 'POST /admin/campaigns/ludian/api/copy', { tagline: '   ' });
  ok(!('tagline' in t.getStored()), '清空「標題下的一句話」＝那行就不顯示');

  // 5) 超長的字要截掉，清單也有上限（避免有人貼一整篇進去）
  t = build();
  await run(t.routes, 'POST /admin/campaigns/ludian/api/copy',
    { page_title: 'X'.repeat(200), tnc: Array.from({ length: 40 }, (_, i) => '第' + i + '條').join('\n') });
  ok(t.getStored().page_title.length <= 40, '太長的標題會截短');
  ok(t.getStored().tnc.length <= 15, '注意事項有條數上限');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n旅電文案編輯全部通過');
  process.exit(failed ? 1 : 0);
})();
