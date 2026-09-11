const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRevisitMessage,
  normalizeBookingRecord,
  normalizeOfferRecord,
  parseDate
} = require('../src/core/revisitEmail');
const { chooseOffer, isPermanentRecipientFailure, selectEligibleCandidates } = require('../src/routes/adminRevisitEmail');

test('訂位匯入支援常用中英文欄名、Excel 日期與保守同意判定', () => {
  const explicitNo = normalizeBookingRecord({
    訂位編號: 'B-1', 餐廳編號: 'R-1', 餐廳名稱: '米花餐廳',
    電子郵件: ' Guest@Example.com ', 姓名: '小明', 用餐日期: 46235,
    狀態: '已到店', 同意行銷: 'unknown-value', 訂位連結: 'https://tw.openrice.com/r/1'
  }, { confirmedMarketing: true });
  assert.equal(explicitNo.ok, true);
  assert.equal(explicitNo.value.customerEmail, 'guest@example.com');
  assert.equal(explicitNo.value.bookingStatus, 'completed');
  assert.equal(explicitNo.value.marketingConsent, false, '無法辨識的非空值不可視為同意');
  assert.match(explicitNo.value.diningDate, /^2026-/);

  const blankConsent = normalizeBookingRecord({
    booking_id: 'B-2', restaurant_id: 'R-1', restaurant_name: '米花餐廳',
    email: 'guest2@example.com', dining_date: '2026/08/01', status: 'completed',
    booking_url: 'https://tw.openrice.com/r/1'
  }, { confirmedMarketing: true });
  assert.equal(blankConsent.ok, true);
  assert.equal(blankConsent.value.marketingConsent, true);
  assert.equal(parseDate('2026年9月3日'), '2026-09-03');
});

test('優惠匯入會驗證期間與 CTA，沒有 ID 時產生穩定 ID', () => {
  const row = {
    餐廳編號: 'R-1', 餐廳名稱: '米花餐廳', 類型: '套餐', 套餐名稱: '雙人套餐',
    開始日期: '2026-09-01', 結束日期: '2026-10-31', 訂位連結: 'https://tw.openrice.com/r/1'
  };
  const first = normalizeOfferRecord(row);
  const second = normalizeOfferRecord(row);
  assert.equal(first.ok, true);
  assert.equal(first.value.offerType, 'set_menu');
  assert.equal(first.value.externalOfferId, second.value.externalOfferId);

  const invalid = normalizeOfferRecord({ ...row, 結束日期: '2026-08-01', 訂位連結: 'javascript:alert(1)' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes('優惠結束日早於開始日'));
  assert.ok(invalid.errors.includes('CTA 連結格式錯誤'));
});

test('同餐廳有多個優惠時優先套餐，並要求優惠仍有足夠天數', () => {
  const offers = [
    { id: 1, restaurant_id: 'R-1', offer_type: 'discount', is_active: true, valid_from: '2026-09-01', valid_until: '2026-12-31' },
    { id: 2, restaurant_id: 'R-1', offer_type: 'set_menu', is_active: true, valid_from: '2026-09-01', valid_until: '2026-09-20' },
    { id: 3, restaurant_id: 'R-2', offer_type: 'set_menu', is_active: true, valid_from: '2026-09-01', valid_until: '2026-12-31' }
  ];
  assert.equal(chooseOffer(offers, 'R-1', '2026-09-10', 7).id, 2);
  assert.equal(chooseOffer(offers, 'R-1', '2026-09-10', 15).id, 1);
});

test('回訪信依套餐／折扣產生不同文案，DB 欄名 CTA 可正確套用且 HTML 會跳脫', () => {
  const message = buildRevisitMessage({
    restaurantName: '<米花餐廳>', recipientName: 'Hen', bookingUrl: 'https://fallback.example.com',
    offer: {
      offer_type: 'set_menu', title: '<雙人套餐>', description: '主廚精選', price_label: 'NT$1,680',
      valid_until: '2026-10-31', cta_url: 'https://offer.example.com'
    },
    clickUrl: 'https://crm.example.com/email/revisit/click/abc',
    unsubscribeUrl: 'https://crm.example.com/email/revisit/unsubscribe/abc',
    openPixelUrl: 'https://crm.example.com/email/revisit/open/abc.gif'
  });
  assert.match(message.subject, /雙人套餐/);
  assert.equal(message.ctaUrl, 'https://offer.example.com');
  assert.match(message.html, /查看套餐並訂位/);
  assert.match(message.html, /https:\/\/crm\.example\.com\/email\/revisit\/click\/abc/);
  assert.match(message.html, /&lt;米花餐廳&gt;/);
  assert.doesNotMatch(message.html, /<米花餐廳>/);
  assert.match(message.text, /https:\/\/offer\.example\.com/);
});

test('完整回訪判定會逐項排除，且同一人一批最多只收到一間餐廳', () => {
  const settings = {
    revisit_after_days: 30, same_restaurant_cooldown_days: 60,
    global_cooldown_days: 7, min_offer_days_remaining: 7
  };
  const base = {
    restaurant_name: '米花餐廳', dining_date: '2026-07-01',
    booking_url: 'https://tw.openrice.com/r/1'
  };
  const bookings = [
    { ...base, id: 1, customer_email: 'due@example.com', restaurant_id: 'R-1' },
    { ...base, id: 2, customer_email: 'due@example.com', restaurant_id: 'R-2' },
    { ...base, id: 3, customer_email: 'early@example.com', restaurant_id: 'R-3', dining_date: '2026-08-20' },
    { ...base, id: 4, customer_email: 'unsub@example.com', restaurant_id: 'R-4' },
    { ...base, id: 5, customer_email: 'sent@example.com', restaurant_id: 'R-5' },
    { ...base, id: 6, customer_email: 'same@example.com', restaurant_id: 'R-6' },
    { ...base, id: 7, customer_email: 'global@example.com', restaurant_id: 'R-7' },
    { ...base, id: 8, customer_email: 'missing@example.com', restaurant_id: 'R-8', booking_url: null }
  ];
  const result = selectEligibleCandidates({
    bookings, offers: [], settings, asOfDate: '2026-09-10',
    unsubscribedEmails: ['unsub@example.com'],
    sentRows: [
      { booking_id: 5, recipient_email: 'sent@example.com', restaurant_id: 'R-5', sent_at: '2026-01-01' },
      { booking_id: 99, recipient_email: 'same@example.com', restaurant_id: 'R-6', sent_at: '2026-08-01' },
      { booking_id: 98, recipient_email: 'global@example.com', restaurant_id: 'OTHER', sent_at: '2026-09-08' }
    ]
  });
  assert.deepEqual(result.eligible.map((item) => item.booking.id), [1]);
  assert.deepEqual(result.excluded, {
    not_due: 1, unsubscribed: 1, suppressed: 0, already_sent: 1,
    restaurant_cooldown: 1, global_cooldown: 2, missing_cta: 1
  });
});

test('抑制名單會在名單產生前排除，只有收件階段永久拒收算硬退信', () => {
  const result = selectEligibleCandidates({
    bookings: [{
      id: 1, customer_email: 'blocked@example.com', restaurant_id: 'R-1', restaurant_name: '米花餐廳',
      dining_date: '2026-01-01', booking_url: 'https://tw.openrice.com/r/1'
    }],
    offers: [], sentRows: [], unsubscribedEmails: [], suppressedEmails: ['blocked@example.com'],
    asOfDate: '2026-09-10',
    settings: { revisit_after_days: 30, same_restaurant_cooldown_days: 60, global_cooldown_days: 0, min_offer_days_remaining: 7 }
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.excluded.suppressed, 1);
  assert.equal(isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO' }), true);
  assert.equal(isPermanentRecipientFailure({ responseCode: 535, command: 'AUTH LOGIN' }), false);
  assert.equal(isPermanentRecipientFailure({ responseCode: 451, command: 'RCPT TO' }), false);
});

test('同店冷卻滿整天數後即可再次寄送', () => {
  const result = selectEligibleCandidates({
    bookings: [{
      id: 1, customer_email: 'guest@example.com', restaurant_id: 'R-1', restaurant_name: '米花餐廳',
      dining_date: '2026-01-01', booking_url: 'https://tw.openrice.com/r/1'
    }],
    offers: [], unsubscribedEmails: [], asOfDate: '2026-09-10',
    settings: { revisit_after_days: 30, same_restaurant_cooldown_days: 60, global_cooldown_days: 0, min_offer_days_remaining: 7 },
    sentRows: [{ booking_id: 99, recipient_email: 'guest@example.com', restaurant_id: 'R-1', sent_at: '2026-07-12' }]
  });
  assert.equal(result.eligible.length, 1);
});
