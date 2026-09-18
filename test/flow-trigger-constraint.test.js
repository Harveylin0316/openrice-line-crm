const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FLOW_TRIGGER_TYPES } = require('../src/routes/adminFlows');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260918074710_extend_admin_flows_trigger_types.sql'
);

test('admin_flows 資料庫限制涵蓋後端允許的全部觸發方式', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /admin_flows_trigger_check/);
  assert.match(sql, /array\['public', 'crm_staging'\]/);
  for (const triggerType of FLOW_TRIGGER_TYPES) {
    assert.match(sql, new RegExp(`''${triggerType}''`), `migration 缺少 ${triggerType}`);
  }
});

test('新圖文選單與活動開啟觸發方式都受資料庫 migration 保護', () => {
  assert.ok(FLOW_TRIGGER_TYPES.includes('rich_menu_tap'));
  assert.ok(FLOW_TRIGGER_TYPES.includes('campaign_open'));
});
