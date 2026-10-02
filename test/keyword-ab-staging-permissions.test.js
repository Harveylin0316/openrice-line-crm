'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStagingMigration, TABLES } = require('../scripts/staging/keyword-ab-migration');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('keyword A/B staging policies are schema-guarded; no role escalation', () => {
  const sql = read('supabase/migrations/20261002090000_keyword_reply_ab_tests.sql');
  const start = sql.indexOf("IF current_schema() = 'crm_staging' THEN");
  assert.ok(start > 0);
  const guarded = sql.slice(start);
  assert.match(guarded, /FOR ALL TO crm_staging_app USING \(true\) WITH CHECK \(true\)/);
  assert.match(guarded, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO crm_staging_app/);
  TABLES.forEach(t => assert.ok(guarded.includes("'" + t + "'")));
  assert.match(guarded, /GRANT USAGE, SELECT ON SEQUENCE/);
  assert.doesNotMatch(sql, /ALTER ROLE|GRANT service_role TO|GRANT ALL[^;]*TO crm_staging_app/i);
  assert.match(sql, /FROM PUBLIC/);
  assert.match(sql, /keyword_reply_experiment_clicks_delivery_idx/);
});

test('staging migration emitter pins schema, stops missing schema, guards FK and public access', () => {
  const sql = buildStagingMigration();
  assert.ok(sql.startsWith('SET LOCAL search_path = crm_staging;'));
  assert.match(sql, /current_schema\(\) IS DISTINCT FROM 'crm_staging'/);
  assert.match(sql, /to_regclass\('crm_staging.admin_keyword_replies'\) IS NULL/);
  assert.match(sql, /target_ns.nspname <> 'crm_staging'/);
  for (const permission of ['SELECT','INSERT','UPDATE','DELETE']) {
    assert.ok(sql.includes("has_table_privilege('crm_staging_app',c.oid,'" + permission + "')"));
  }
  assert.doesNotMatch(read('scripts/staging/keyword-ab-migration.js'), /process\.env|require\(['"]pg['"]\)/);
});

test('actual-role verification is rollback-only and synthetic; no existing data writes', () => {
  const sql = read('scripts/staging/verify-keyword-ab-permissions.sql');
  assert.match(sql, /SET LOCAL ROLE crm_staging_app/);
  assert.match(sql, /BEGIN;/);
  assert.ok(sql.trim().endsWith('ROLLBACK;'));
  TABLES.forEach(t => assert.ok(sql.includes(t)));
  assert.match(sql, /STAGING_SYNTHETIC_PERMISSION_PROBE/);
  assert.doesNotMatch(sql, /INSERT INTO admin_|UPDATE admin_|DELETE FROM admin_|nextval\(|COMMIT;|DROP TABLE/);
});
