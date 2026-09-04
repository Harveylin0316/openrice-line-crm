const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-broadcast.js'), 'utf8');

test('全部測試人員發送失敗時會逐人顯示原因', () => {
  assert.match(source, /failures\.push\(r\.label \+ '：' \+ why\)/);
  assert.match(source, /failures\.map\(escapeHtml\)\.join\('<br>'\)/);
  assert.match(source, /invalid_line_message:\s*'訊息內容不符合 LINE 規格'/);
});
