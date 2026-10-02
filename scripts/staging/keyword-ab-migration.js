'use strict';
// Emit reviewed SQL only. Never loads credentials or connects to a database.
const fs = require('node:fs');
const path = require('node:path');
const TABLES = ['keyword_reply_experiments', 'keyword_reply_experiment_assignments',
  'keyword_reply_experiment_deliveries', 'keyword_reply_experiment_clicks'];

function buildStagingMigration() {
  const up = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002090000_keyword_reply_ab_tests.sql'), 'utf8');
  return `SET LOCAL search_path = crm_staging;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$ BEGIN
  IF current_schema() IS DISTINCT FROM 'crm_staging' OR
     to_regclass('crm_staging.admin_keyword_replies') IS NULL THEN
    RAISE EXCEPTION 'Staging schema or keyword rules missing; refusing migration';
  END IF;
END $guard$;
${up}
DO $guard$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class target ON target.oid=k.confrelid
      JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace
    WHERE n.nspname='crm_staging' AND c.relname IN (${TABLES.map(t => "'" + t + "'").join(',')})
      AND k.contype='f' AND target_ns.nspname <> 'crm_staging'
  ) THEN RAISE EXCEPTION 'Staging foreign key escapes isolation'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege('crm_staging_app',c.oid,'SELECT')
        OR has_table_privilege('crm_staging_app',c.oid,'INSERT')
        OR has_table_privilege('crm_staging_app',c.oid,'UPDATE')
        OR has_table_privilege('crm_staging_app',c.oid,'DELETE'))
  ) THEN RAISE EXCEPTION 'Staging role can access production'; END IF;
END $guard$;`;
}
if (require.main === module) process.stdout.write(buildStagingMigration());
module.exports = { buildStagingMigration, TABLES };
