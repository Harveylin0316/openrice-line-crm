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
  assert.match(html, /每週資料上傳/);
  assert.match(html, /產生本週回訪草稿/);
  assert.match(html, /從公司信箱寄下一批/);
  assert.match(html, /我確認這份資料中的 Email 可用於回訪行銷/);
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\ssrc=/i.test(match[1])).map((match) => match[2]);
  scripts.forEach((script) => assert.doesNotThrow(() => new vm.Script(script)));
});

test('migration 對所有客戶資料表啟用 RLS，且不授權 anon/authenticated', () => {
  const sql = fs.readFileSync(path.join(REPO, 'supabase/migrations/20260910085055_create_revisit_email.sql'), 'utf8');
  const tables = ['settings', 'imports', 'bookings', 'offers', 'campaigns', 'recipients'];
  tables.forEach((name) => assert.match(sql, new RegExp(`ALTER TABLE public\\.revisit_email_${name} ENABLE ROW LEVEL SECURITY`)));
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM anon, authenticated/);
  assert.match(sql, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
  assert.doesNotMatch(sql, /GRANT .* TO anon|GRANT .* TO authenticated/);
});
