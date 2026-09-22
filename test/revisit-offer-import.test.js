const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  NATIVE_HEADERS,
  parseNativeHtml,
  buildNativeTemplateHtml,
  encodeUtf16Le
} = require('../public/revisit-offer-import');

test('公司後台 HTML-as-XLS 會轉成優惠資料列', () => {
  const values = {
    'Offer ID': '552992',
    'OR Restaurant ID': '653180',
    'Restaurant Name(Lang1)': '範例餐廳',
    'Offer Title': '會員優惠',
    'Start Date': '2026/09/15',
    'End Time': '2026/09/30',
    Status: 'Active'
  };
  const html = '<html><body><table><tr>' +
    NATIVE_HEADERS.map((header) => '<td class="Header">' + header + '</td>').join('') +
    '</tr><tr>' + NATIVE_HEADERS.map((header) => '<td>' + (values[header] || '') + '</td>').join('') +
    '</tr></table></body></html>';
  const rows = parseNativeHtml(html, new JSDOM('').window.DOMParser);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Offer ID'], '552992');
  assert.equal(rows[0]['Restaurant Name(Lang1)'], '範例餐廳');
});

test('原生優惠範本保留 21 欄並以 UTF-16LE BOM 輸出', () => {
  const html = buildNativeTemplateHtml();
  NATIVE_HEADERS.forEach((header) => assert.ok(html.includes(header)));
  const bytes = encodeUtf16Le(html);
  assert.equal(bytes[0], 0xFF);
  assert.equal(bytes[1], 0xFE);
});
