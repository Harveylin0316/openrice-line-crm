const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const template = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'gold_pig_liff.ejs'),
  'utf8'
);

test('LIFF initializes before the booking token is read or the URL is rewritten', () => {
  const bindStart = template.indexOf('async function bind()');
  const init = template.indexOf('await initLiff()', bindStart);
  const tokenRead = template.indexOf('token = readBookingTokenAfterInit()', bindStart);
  const addressRewrite = template.indexOf('removeTokenFromAddressBar()', tokenRead);

  assert.ok(bindStart > -1, 'bind flow should exist');
  assert.ok(init > bindStart, 'LIFF should initialize inside bind flow');
  assert.ok(tokenRead > init, 'booking token must be read only after LIFF initialization');
  assert.ok(addressRewrite > tokenRead, 'URL must not be rewritten before the token is restored');
});

test('failed booking links offer a LINE support handoff instead of a retry loop only', () => {
  assert.match(template, /id="bookingHelp"/);
  assert.match(template, /請 OpenRice 協助查詢/);
  assert.match(template, /不需要重複付款/);
  assert.doesNotMatch(template, /請回到付款完成頁/);
});
