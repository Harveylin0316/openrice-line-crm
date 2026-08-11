const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createGoldPigBookingService,
  formatDateValue,
  generateBookingToken,
  hashBookingToken,
  normalizeBookingNo
} = require('../src/core/goldPigBookings');
const { registerGoldPigRoutes, validateBookingInput } = require('../src/routes/goldPig');

test('campaign CORS allows GitHub Pages and the company FTP domain', async (t) => {
  const app = express();
  registerGoldPigRoutes(app, {
    pool: {},
    liffId: '',
    bookingApiKey: '',
    demoMode: false,
    allowedOrigins: 'https://twopenrice-ops.github.io,https://tw.openrice.com',
    lineOfficialAddFriendUrl: ''
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();

  for (const path of ['/api/gold-pig/demo-bookings', '/api/gold-pig/bind']) {
    for (const origin of ['https://twopenrice-ops.github.io', 'https://tw.openrice.com']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type'
        }
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
  }

  const blocked = await fetch(`http://127.0.0.1:${port}/api/gold-pig/demo-bookings`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(blocked.status, 403);
});

test('new booking LIFF links keep the token in the query without an appended route', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'routes', 'goldPig.js'),
    'utf8'
  );
  assert.match(source, /liff\.line\.me\/\$\{encodeURIComponent\(liffId\)\}\?token=/);
  assert.doesNotMatch(source, /liff\.line\.me\/\$\{encodeURIComponent\(liffId\)\}\/bind\?token=/);
});

test('booking token is random, URL-safe hex and stored only as a hash', () => {
  const first = generateBookingToken();
  const second = generateBookingToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.match(hashBookingToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashBookingToken(first), first);
});

test('booking input accepts one or two tables and rejects impossible orders', () => {
  assert.equal(validateBookingInput({
    date: '2026-08-28', time: '19:30', tables4: 1, tables6: 1, totalAmount: 22800
  }).ok, true);
  assert.deepEqual(validateBookingInput({
    date: '2026-08-28', time: '19:30', tables4: 0, tables6: 0, totalAmount: 1
  }), { ok: false, error: 'invalid_tables' });
});

test('booking number normalization is strict', () => {
  assert.equal(normalizeBookingNo(' gp260828abc123 '), 'GP260828ABC123');
  assert.equal(normalizeBookingNo('bad number!'), '');
});

test('database date values serialize as ISO dates', () => {
  assert.equal(formatDateValue(new Date('2026-08-28T00:00:00.000Z')), '2026-08-28');
  assert.equal(formatDateValue('2026-09-25'), '2026-09-25');
});

test('query command returns linked bookings without contact data', async () => {
  const pool = {
    query: async () => ({ rows: [{
      booking_no: 'GP260828ABC123', status: 'confirmed', session_date: '2026-08-28',
      session_time: '19:30:00', tables_4: 1, tables_6: 0, total_amount: 9120
    }] })
  };
  const service = createGoldPigBookingService({ pool });
  const result = await service.handleCommand('U123', '查詢訂位');
  assert.equal(result.result, 'gold_pig_booking_queried');
  assert.match(result.messages[0], /GP260828ABC123/);
  assert.doesNotMatch(result.messages[0], /contact|phone|email/i);
});

test('unrelated messages are left for the existing keyword engine', async () => {
  const service = createGoldPigBookingService({ pool: {} });
  assert.equal(await service.handleCommand('U123', '我要看優惠'), null);
});
