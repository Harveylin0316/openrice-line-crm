const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGoldPigBookingService,
  generateBookingToken,
  hashBookingToken,
  normalizeBookingNo
} = require('../src/core/goldPigBookings');
const { validateBookingInput } = require('../src/routes/goldPig');

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
