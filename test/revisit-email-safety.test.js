const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const { createSmtpEmailProvider } = require('../src/core/emailProviderSmtp');

const REPO = path.join(__dirname, '..');

test('SMTP 沒有本機完整設定時不會嘗試連線或寄信', async () => {
  const keys = ['SMTP_HOST', 'SMTP_SERVER', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM_EMAIL', 'SMTP_FROM'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  try {
    const provider = createSmtpEmailProvider();
    assert.equal(provider.isConfigured(), false);
    assert.deepEqual(await provider.verify(), { ok: false, error: 'smtp_not_configured' });
    assert.deepEqual(await provider.sendEmail({ to: 'x@example.com', subject: 'x', html: '<p>x</p>' }), { ok: false, error: 'smtp_not_configured' });
  } finally {
    keys.forEach((key) => {
      if (old[key] == null) delete process.env[key]; else process.env[key] = old[key];
    });
  }
});

test('回訪 Email 頁面可渲染且瀏覽器程式碼語法正確', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_revisit_email.ejs'), {
    title: '訂位客回訪 Email', bodyClass: 'admin-shell', user: 'Hen', isAdmin: true, isOwner: true
  }, { views: [path.join(REPO, 'views')] });
  assert.match(html, /你只要完成 4 步/);
  assert.match(html, /同步這段期間的訂位/);
  assert.match(html, /訂位成效報表資料更新至/);
  assert.match(html, /暫時無法取得最新更新日期/);
  assert.match(html, /同步中：已處理/);
  assert.match(html, /處理時間過長，系統已停止這次操作/);
  assert.match(html, /沒有優惠也可以跳過/);
  assert.match(html, /後台下載的 \.xls/);
  assert.match(html, /下載原生欄位範本/);
  assert.match(html, /revisit-offer-import\.js/);
  assert.match(html, /產生回訪信草稿/);
  assert.match(html, /確認，正式寄給客人/);
  assert.match(html, /③ 寄這封到測試信箱/);
  assert.match(html, /不是只找剛好第/);
  assert.match(html, /booking_import_id:state\.bookingSource\.id/);
  assert.match(html, /你現在開的是正式網站，這裡刻意不能寄信/);
  assert.match(html, /http:\/\/localhost:3000\/admin\/revisit-email/);
  assert.match(html, /api\/provider\/verify/);
  assert.match(html, /永遠不要再寄/);
  assert.match(html, /寄件備份有這封：標記為公司信箱已接受/);
  assert.match(html, /不代表客人的信箱已收件/);
  assert.match(html, /公司信箱已接受/);
  assert.match(html, /寄送結果不確定/);
  assert.match(html, /我確認公司可以使用這批 Email 寄送回訪信/);
  assert.match(html, /進階：調整寄送規則/);
  assert.match(html, /String\(c\.as_of_date\|\|''\)\.slice\(0,10\)/);
  assert.doesNotMatch(html, /可判定來源|寄正式等同測試信|從公司信箱寄下一批|已寄出 Email/);
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\ssrc=/i.test(match[1])).map((match) => match[2]);
  scripts.forEach((script) => assert.doesNotThrow(() => new vm.Script(script)));
});

test('回訪 Email 安全 migration 保護測試、稽核與抑制資料表', () => {
  const sql = fs.readFileSync(path.join(REPO, 'supabase/migrations/20260911105839_revisit_email_delivery_safety.sql'), 'utf8');
  ['test_deliveries', 'recipient_events', 'suppressions'].forEach((name) => {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.revisit_email_${name} ENABLE ROW LEVEL SECURITY`));
  });
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /content_version/);
  assert.match(sql, /tested_version/);
  assert.doesNotMatch(sql, /GRANT .* TO anon|GRANT .* TO authenticated/);
  const indexes = fs.readFileSync(path.join(REPO, 'supabase/migrations/20260911111039_revisit_email_fk_indexes.sql'), 'utf8');
  ['bookings_import', 'offers_import', 'recipients_offer'].forEach((name) => {
    assert.match(indexes, new RegExp(`revisit_email_${name}_idx`));
  });
});

test('migration 對所有客戶資料表啟用 RLS，且不授權 anon/authenticated', () => {
  const sql = fs.readFileSync(path.join(REPO, 'supabase/migrations/20260910085055_create_revisit_email.sql'), 'utf8');
  const tables = ['settings', 'imports', 'bookings', 'offers', 'campaigns', 'recipients'];
  tables.forEach((name) => assert.match(sql, new RegExp(`ALTER TABLE public\\.revisit_email_${name} ENABLE ROW LEVEL SECURITY`)));
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM anon, authenticated/);
  assert.match(sql, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
  assert.doesNotMatch(sql, /GRANT .* TO anon|GRANT .* TO authenticated/);
});
