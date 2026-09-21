const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRestaurantSearchUrl, createBookingReportClient } = require('../src/core/bookingReportClient');

test('訂位報表 client 只把 token 放在 Authorization，並限制分頁大小', async () => {
  let seen;
  const client = createBookingReportClient({
    apiUrl: 'https://report.example/.netlify/functions/crm-revisit-bookings',
    token: 'server-only-token',
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return { ok: true, status: 200, json: async () => ({ ok: true, rows: [{ booking_ref_id: 'B1' }], total: 1, limit: 1000, offset: 0 }) };
    }
  });
  const result = await client.fetchPage({ from: '2026-09-01', to: '2026-09-21', offset: 0, limit: 9999 });
  assert.equal(result.total, 1);
  assert.match(seen.url, /limit=1000/);
  assert.equal(seen.options.headers.Authorization, 'Bearer server-only-token');
  assert.ok(!seen.url.includes('server-only-token'));
});

test('回訪的餐廳備援連結使用店名搜尋並帶 email 來源', () => {
  const url = new URL(buildRestaurantSearchUrl('好吃餐廳'));
  assert.equal(url.searchParams.get('what'), '好吃餐廳');
  assert.equal(url.searchParams.get('utm_source'), 'email');
  assert.equal(url.searchParams.get('utm_campaign'), 'revisit_email');
});
