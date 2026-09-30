'use strict';
// 名單庫：可用「訂位來源（問卷最新回答）」建受眾，與首頁訂位來源統計、群發條件同一口徑。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { cleanDefinition, compileAudience } = require('../src/core/audienceSegments');
const { registerAdminRecipientListsRoutes } = require('../src/routes/adminRecipientLists');

const REPO = path.join(__dirname, '..');

test('訂位來源條件：代號正規化、查每人最新一筆回答', () => {
  const clean = cleanDefinition({ conditions: [{ type: 'booking_source', value: ' Google ' }] });
  assert.deepEqual(clean.conditions[0], { type: 'booking_source', mode: 'include', value: 'google' });
  const compiled = compileAudience({ conditions: [{ type: 'booking_source', value: 'openrice' }] });
  assert.match(compiled.sql, /member_booking_source bs/);
  assert.match(compiled.sql, /bs\.source_key=\$1::text/);
  assert.deepEqual(compiled.params.slice(0, 1), ['openrice']);
  assert.throws(() => cleanDefinition({ conditions: [{ type: 'booking_source', value: '' }] }), /請選擇訂位來源/);
});

test('回答過訂位來源：可包含或排除（排除＝還沒回答過，可以再問一次）', () => {
  const compiled = compileAudience({ conditions: [{ type: 'is_friend' }, { type: 'booking_source_answered', mode: 'exclude' }] });
  assert.match(compiled.sql, /NOT \(EXISTS \(SELECT 1 FROM member_booking_source bs WHERE bs\.line_user_id=u\.line_user_id\)\)/);
});

test('catalog 回傳訂位來源選項：實際回答中的來源＋固定的 OpenRice／Google', async () => {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  registerAdminRecipientListsRoutes(app, {
    query: async (sql) => {
      if (/FROM member_booking_source/.test(sql)) return { rows: [{ id: 'google', label: 'Google', people: 120 }, { id: 'ubereats', label: 'Uber Eats', people: 3 }] };
      return { rows: [] };
    },
    pool: {}, authCore: { requireAdmin: (_q, _s, n) => n() }
  });
  const res = { json(b) { this.body = b; return this; }, status() { return this; } };
  const h = routes['GET /admin/recipient-lists/api/catalog'];
  await h[h.length - 1]({}, res);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.deepEqual(res.body.booking_sources.map(b => b.id), ['google', 'ubereats', 'openrice']);
  assert.equal(res.body.booking_sources[0].name, '透過 Google（120 人回答）');
  assert.equal(res.body.booking_sources[2].name, '透過 OpenRice');
});

test('名單庫條件選單有「訂位來源」，選了之後出現來源下拉並送出正確定義', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_recipient_lists.ejs'), {
    title: '名單庫', user: 'admin', isAdmin: true, bodyClass: 'admin-shell', lists: [], dynamicLists: []
  }, { views: [path.join(REPO, 'views')] }).catch(e => { throw new Error('render failed: ' + e.message); });
  const previews = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/admin/recipient-lists',
    beforeParse(window) {
      window.fetch = async (u, opts) => {
        if (String(u).includes('/api/catalog')) {
          return { json: async () => ({ ok: true, tags: [], activities: [], menus: [], broadcasts: [], booking_sources: [{ id: 'openrice', name: '透過 OpenRice（80 人回答）' }, { id: 'google', name: '透過 Google（120 人回答）' }] }) };
        }
        if (opts && opts.body) previews.push(JSON.parse(opts.body));
        return { json: async () => ({ ok: true, total: 0, sample: [] }) };
      };
    }
  });
  await new Promise(r => setTimeout(r, 120));
  const doc = dom.window.document;
  // 選「動態名單」，再按「新增條件」建立一列（真實 UI 流程）
  const dynRadio = doc.querySelector('input[name="nl-type"][value="dynamic"]');
  dynRadio.checked = true;
  dynRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  doc.getElementById('aud-add').click();
  const typeOptions = [...doc.querySelectorAll('.aud-condition .aud-type option')].map(o => o.value);
  assert.ok(typeOptions.includes('booking_source'));
  const row = doc.querySelector('.aud-condition');
  const typeSel = row.querySelector('.aud-type');
  typeSel.value = 'booking_source';
  typeSel.dispatchEvent(new dom.window.Event('change'));
  const valueSel = row.querySelector('.aud-value');
  assert.deepEqual([...valueSel.options].map(o => o.value), ['openrice', 'google']);
  valueSel.value = 'google';
  valueSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 450));   // 預覽有 350ms 防抖
  const lastPreview = previews[previews.length - 1];
  assert.ok(lastPreview && lastPreview.definition, '應送出受眾試算');
  assert.deepEqual(lastPreview.definition.conditions.slice(-1)[0], { mode: 'include', type: 'booking_source', value: 'google' });
  dom.window.close();
});
