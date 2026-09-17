'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateRange, loadBookingSource } = require('../src/routes/adminDashboard');

test('dashboard booking source accepts an inclusive custom range', async () => {
  assert.deepEqual(parseDateRange({ booking_from: '2026-09-01', booking_to: '2026-09-17' }), {
    from: '2026-09-01', to: '2026-09-17'
  });
  assert.equal(parseDateRange({}), null);
  assert.throws(() => parseDateRange({ booking_from: '2026-09-18', booking_to: '2026-09-17' }), /日期/);

  let call;
  const result = await loadBookingSource(async (sql, params) => {
    call = { sql: String(sql), params };
    return { rows: [{ label: 'OpenRice', total: 9, current_members: 7 }] };
  }, { from: '2026-09-01', to: '2026-09-17' });
  assert.deepEqual(call.params, ['2026-09-01', '2026-09-17']);
  assert.match(call.sql, /booking_source_answers/);
  assert.match(call.sql, /BETWEEN \$1::date AND \$2::date/);
  assert.equal(result.total, 9);
  assert.equal(result.current, 7);
});
