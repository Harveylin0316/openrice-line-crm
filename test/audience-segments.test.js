'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanDefinition, compileAudience } = require('../src/core/audienceSegments');

test('normalizes AND/OR and validates unsafe values', () => {
  assert.equal(cleanDefinition({ operator: 'OR', conditions: [{ type: 'is_friend' }] }).operator, 'or');
  assert.throws(() => cleanDefinition({ conditions: [] }), /至少/);
  assert.throws(() => cleanDefinition({ conditions: [{ type: 'tag', value: '1 OR 1=1' }] }), /有效編號/);
  assert.throws(() => cleanDefinition({ conditions: [{ type: 'joined_after', value: 'tomorrow' }] }), /日期/);
});

test('compiles values as parameters and never interpolates them', () => {
  const out = compileAudience({ operator: 'and', conditions: [
    { type: 'joined_after', value: '2026-09-01' },
    { type: 'liff_event', value: "x' OR true --" }
  ] });
  assert.deepEqual(out.params, ['2026-09-01', "x' OR true --"]);
  assert.doesNotMatch(out.sql, /OR true --/);
  assert.match(out.sql, /\$1::date/);
  assert.match(out.sql, /event_name = \$2/);
});

test('OR applies only to include clauses; every exclusion remains mandatory', () => {
  const out = compileAudience({ operator: 'or', conditions: [
    { mode: 'include', type: 'is_friend' },
    { mode: 'include', type: 'tag', value: 9 },
    { mode: 'exclude', type: 'broadcast_sent', value: 42 },
    { mode: 'exclude', type: 'broadcast_tested', value: 43 }
  ] });
  assert.match(out.where, /^\(\(.+\) OR \(.+\)\) AND NOT \(.+\) AND NOT \(.+\)$/s);
  assert.deepEqual(out.params, [9, 42, 43]);
});

test('supports required behavior and reward dimensions', () => {
  const types = [
    ['rich_menu', 1], ['rich_menu_button', '1:0:2'], ['activity', 2],
    ['activity_enter', 2], ['activity_start', 2], ['activity_complete', 2], ['activity_share', 2],
    ['invite_count', 3], ['reward_status', 'unclaimed'],
    ['follow_event', null], ['block_event', null], ['unblock_event', null],
    ['line_login', null], ['app_registration', null], ['booking_confirmed', null],
    ['booking_cancelled', null], ['broadcast_converted', 8]
  ];
  const out = compileAudience({ conditions: types.map(([type, value]) => ({ type, value })) });
  assert.match(out.sql, /rich_menu_taps/);
  assert.match(out.sql, /rt\.cell=/);
  assert.match(out.sql, /activity_user_events/);
  assert.match(out.sql, /activity_referrals/);
  assert.match(out.sql, /ap\.is_redeemed/);
  assert.doesNotMatch(out.sql, /coupon_codes/);
  assert.match(out.sql, /line_webhook_events/);
  assert.match(out.sql, /campaign_phone_registrations/);
  assert.match(out.sql, /gold_pig_bookings/);
  assert.match(out.sql, /admin_broadcast_clicks/);
});

test('rejects malformed rich-menu button identity', () => {
  assert.throws(() => compileAudience({ conditions: [{ type: 'rich_menu_button', value: '1 OR true' }] }), /格式/);
});
