'use strict';
// 關鍵字回覆紀錄：可設定期間，看每條規則的觸發次數，以及每天／每小時／一天中各時段的分布
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { registerAdminKeywordRepliesRoutes } = require('../src/routes/adminKeywordReplies');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const twToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (ymd, d) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

function route() {
  const routes = {};
  const sqls = [];
  const app = ['get', 'post', 'delete', 'put'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  registerAdminKeywordRepliesRoutes(app, {
    query: async (sql, params) => { sqls.push({ sql: String(sql), params }); return /ORDER BY created_at ASC LIMIT 1/.test(sql) ? { rows: [{ created_at: '2026-08-01T00:00:00Z' }] } : { rows: [] }; },
    authCore: { requireAdmin: (_q, _s, n) => n() }
  });
  const call = async (query) => { const r = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await routes['GET /admin/keyword-replies/api/stats'].at(-1)({ query }, r); return r; };
  return { call, sqls };
}

test('紀錄 API：依台灣時間的期間查 webhook 紀錄；只算命中規則的結果；驗證日期與每小時最多 7 天', async () => {
  const { call, sqls } = route();
  const ok = await call({ from: '2026-10-12', to: '2026-10-18', rule_id: '7', granularity: 'hour_of_day' });
  assert.equal(ok.code, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store');
  const main = sqls.find(s => /AS triggers/.test(s.sql));
  assert.match(main.sql, /FROM line_webhook_events/);
  assert.match(main.sql, /substring\(detail from 'rule#\(\[0-9\]\+\)'\)/);
  assert.deepEqual(main.params.slice(0, 3), ['2026-10-12T00:00:00+08:00', '2026-10-18T00:00:00+08:00',
    ['keyword_replied', 'keyword_fallback_replied', 'keyword_reply_failed', 'keyword_fallback_reply_failed']]);
  assert.ok(sqls.some(s => /to_char\(at AT TIME ZONE 'Asia\/Taipei', 'HH24'\)/.test(s.sql)), '一天中各時段依台灣時間分組');
  assert.equal(ok.body.first_record_at, '2026-08-01T00:00:00Z');
  assert.equal((await call({ from: '2026/10/12', to: '2026-10-18' })).code, 400);
  assert.equal((await call({ from: '2026-10-18', to: '2026-10-12' })).code, 400);
  assert.equal((await call({ from: '2026-10-01', to: '2026-10-18', granularity: 'hour', rule_id: '7' })).code, 400);
  assert.equal((await call({ from: '2025-01-01', to: '2026-10-18' })).code, 400, '最長 366 天');
});

async function openPage(stats) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_keyword_replies.ejs'), { title: '關鍵字回覆', user: 'admin', isAdmin: true, bodyClass: 'admin-shell' }, { views: [path.join(REPO, 'views')] });
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://crm.example/admin/keyword-replies', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (u) => {
        u = String(u); calls.push(u);
        if (u === '/admin/keyword-replies/api/list') return { json: async () => ({ ok: true, ab_enabled: false, templates: [],
          rules: [{ id: 7, keywords: '透過 OpenRice 訂位', match_type: 'exact', template_name: 'STAGING', is_active: true, hit_count: 520, priority: 10 },
                  { id: 8, keywords: '更改訂位', match_type: 'exact', template_name: 'STAGING', is_active: true, hit_count: 90, priority: 20 }] }) };
        if (u.indexOf('/admin/keyword-replies/api/stats') === 0) return { json: async () => stats(u) };
        return { json: async () => ({ ok: true }) };
      };
    } });
  await wait(80);
  return { dom, doc: dom.window.document, calls };
}

test('規則清單：預設近 7 天（台灣日期）顯示期間觸發次數、成功／失敗／人數與累計', async () => {
  const t = twToday();
  const { dom, doc, calls } = await openPage(() => ({ ok: true, totals: [{ rule_id: 7, triggers: 41, replied: 40, failed: 1, people: 33 }], first_record_at: '2026-08-01T00:00:00Z' }));
  assert.ok(calls.includes('/admin/keyword-replies/api/stats?from=' + shift(t, -6) + '&to=' + t));
  const cells = [...doc.querySelectorAll('#kr-tbody tr')].map(tr => tr.children[4].textContent.replace(/\s+/g, ''));
  assert.equal(cells[0], '41成功40・失敗1・33人累計520');
  assert.equal(cells[1], '0累計90', '期間內沒觸發顯示 0');
  assert.match(doc.getElementById('kr-range-status').textContent, /觸發紀錄從 2026\/8\/1 起才有/);
  assert.match(doc.querySelector('.kr-table thead').textContent, /期間觸發次數/);
  dom.window.close();
});

test('紀錄面板：每天補齊 0、一天中各時段 24 格；切換統計方式重新查詢；每小時超過 7 天顯示原因', async () => {
  const { dom, doc, calls } = await openPage((u) => {
    if (u.indexOf('rule_id=7') < 0) return { ok: true, totals: [{ rule_id: 7, triggers: 3, replied: 3, failed: 0, people: 2 }] };
    if (/granularity=hour_of_day/.test(u)) return { ok: true, totals: [{ rule_id: 7, triggers: 3, replied: 3, failed: 0, people: 2 }], series: [{ bucket: '09', triggers: 2, replied: 2, people: 1 }, { bucket: '23', triggers: 1, replied: 1, people: 1 }] };
    if (/granularity=hour$/.test(u)) {
      const m = u.match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/);
      const span = Math.round((Date.parse(m[2]) - Date.parse(m[1])) / 86400000) + 1;
      if (span > 7) return { ok: false, error: '「每小時」最多看 7 天，請縮短期間或改看「每天」' };
      return { ok: true, totals: [], series: [] };
    }
    return { ok: true, totals: [{ rule_id: 7, triggers: 3, replied: 3, failed: 0, people: 2 }], series: [{ bucket: twToday(), triggers: 3, replied: 3, people: 2 }] };
  });
  doc.querySelector('.kr-stats-btn[data-id="7"]').click();
  await wait(40);
  assert.equal(doc.getElementById('kr-stats-card').hidden, false);
  assert.match(doc.getElementById('kr-stats-sum').textContent, /3 次觸發.*3 次成功回覆.*2 位不重複客人/);
  const dayRows = doc.querySelectorAll('#kr-stats-bars .kr-bar-row');
  assert.equal(dayRows.length, 7, '近 7 天每天一列，沒觸發的也列出');
  assert.equal(doc.querySelectorAll('#kr-stats-bars .kr-bar-row.zero').length, 6);
  doc.querySelector('[data-kr-gran="hour_of_day"]').click();
  await wait(40);
  assert.ok(calls.some(c => /rule_id=7&granularity=hour_of_day/.test(c)));
  const hod = [...doc.querySelectorAll('#kr-stats-bars .kr-bar-row')];
  assert.equal(hod.length, 24);
  assert.match(hod[9].textContent, /09:00.*2（1 人）/);
  doc.querySelector('[data-kr-gran="hour"]').click();
  await wait(40);
  assert.equal(doc.querySelectorAll('#kr-stats-bars .kr-bar-row').length, 7 * 24, '近 7 天每小時：168 格');
  doc.querySelector('[data-kr-range="30d"]').click();
  await wait(60);
  assert.match(doc.getElementById('kr-stats-bars').textContent, /最多看 7 天/, '期間超過 7 天看每小時：顯示原因');
  assert.match(doc.getElementById('kr-stats-defs').textContent, /同一人傳 3 次算 3 次/);
  assert.match(doc.getElementById('kr-stats-defs').textContent, /台灣時間/);
  dom.window.close();
});
