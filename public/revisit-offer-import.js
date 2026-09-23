(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RevisitOfferImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const NATIVE_HEADERS = [
    'Offer ID', 'Account ID', 'Account Name', 'TM Restaurant ID', 'OR Restaurant ID',
    'Restaurant Name(Lang1)', 'Offer Type', 'IsORsponsor', 'Offer Title',
    'Offer Title Lang2', 'Offer Title Lang3', 'DiscountType', 'Discount',
    'Total Redeem', 'Submission Time', 'Start Date', 'End Time', 'Valid Date',
    'Exclude Date', 'Distribution Channel(s)', 'Status'
  ];

  function clean(value) {
    return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseNativeHtml(text, Parser) {
    const DomParser = Parser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DomParser) throw new Error('目前的瀏覽器無法解析這份 .xls，請改用 Chrome 或 Edge。');
    const document = new DomParser().parseFromString(String(text || '').replace(/^\uFEFF/, ''), 'text/html');
    const table = document.querySelector('table');
    if (!table) throw new Error('這不是 Discount Offer 後台匯出的 .xls 表格。');
    const matrix = Array.from(table.querySelectorAll('tr')).map(function (tr) {
      return Array.from(tr.querySelectorAll('th,td')).map(function (cell) { return clean(cell.textContent); });
    }).filter(function (row) { return row.some(Boolean); });
    if (matrix.length < 2) throw new Error('檔案只有欄名，沒有可匯入的優惠資料。');
    const headers = matrix[0];
    if (!headers.includes('Offer ID') || !headers.includes('OR Restaurant ID') || !headers.includes('Restaurant Name(Lang1)')) {
      throw new Error('欄位不是公司 Discount Offer 後台的原生格式。');
    }
    return matrix.slice(1).map(function (values) {
      const row = {};
      headers.forEach(function (header, index) { row[header] = values[index] == null ? '' : values[index]; });
      return row;
    }).filter(function (row) { return Object.values(row).some(Boolean); });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildNativeTemplateHtml() {
    return '<html><head><meta charset="utf-16"><style>' +
      'td{border:1px solid black;padding:2px 3px;vertical-align:top}td.Header{background-color:gray;color:white;font-weight:bold}' +
      '</style></head><body><table><tr>' +
      NATIVE_HEADERS.map(function (header) { return '<td class="Header">' + escapeHtml(header) + '</td>'; }).join('') +
      '</tr></table></body></html>';
  }

  function encodeUtf16Le(text) {
    const value = String(text || '');
    const bytes = new Uint8Array(2 + value.length * 2);
    bytes[0] = 0xFF;
    bytes[1] = 0xFE;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      bytes[2 + index * 2] = code & 0xFF;
      bytes[3 + index * 2] = code >>> 8;
    }
    return bytes;
  }

  return { NATIVE_HEADERS, parseNativeHtml, buildNativeTemplateHtml, encodeUtf16Le };
}));
