const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('legacy 初始化只處理目前 schema，不會從 preview 誤改 production public', () => {
  const source = read('src/core/dbInit.js');
  assert.match(source, /current_schema\(\)/);
  assert.doesNotMatch(source, /ALTER TABLE public\.%I/);
  assert.doesNotMatch(source, /CREATE POLICY app_server_full_access ON public\.%I/);
});

test('staging bootstrap 不含真實憑證或正式資料複製', () => {
  const sql = read('scripts/staging/bootstrap-staging.sql');
  assert.match(sql, /__STAGING_DB_PASSWORD__/);
  assert.match(sql, /__STAGING_ADMIN_PASSWORD__/);
  assert.match(sql, /WITH NO DATA|LIKE public\.%I INCLUDING ALL/);
  assert.doesNotMatch(sql, /INSERT INTO crm_staging\.[^\n]+SELECT \* FROM public\./i);
  assert.match(sql, /has_table_privilege\('crm_staging_app', 'public\.users', 'SELECT'\)/);
  assert.match(sql, /unsafe staging role: a production public relation is accessible/);
  assert.match(sql, /CREATE OR REPLACE VIEW crm_staging\.member_booking_source/);
  assert.match(sql, /FROM crm_staging\.booking_source_answers/);
  assert.match(sql, /FROM crm_staging\.user_events ue/);
  assert.match(sql, /JOIN crm_staging\.users u/);
  assert.match(sql, /unsafe staging view/);
  assert.match(sql, /unsafe staging foreign key/);
});

test('preview 模式有明顯橫幅與 health check 訊號', () => {
  const app = read('src/app.js');
  const layout = read('views/layout.ejs');
  assert.match(app, /SAFE_PREVIEW_MODE/);
  assert.match(app, /safePreviewMode: isSafePreview/);
  assert.match(layout, /STAGING 測試環境/);
  assert.match(layout, /不會真的傳 LINE、寄 Email 或建立正式訂位/);
});
