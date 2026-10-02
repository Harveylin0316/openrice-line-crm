'use strict';
// Reviewed production SQL only; does not connect, load secrets, or deploy.
const fs=require('node:fs');
const path=require('node:path');
const {TABLES}=require('../staging/keyword-ab-migration');
function buildProductionMigration(){
 const up=fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261002090000_keyword_reply_ab_tests.sql'),'utf8');
 return `SET LOCAL search_path = public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$ BEGIN
 IF current_schema() IS DISTINCT FROM 'public' OR to_regclass('public.admin_keyword_replies') IS NULL THEN
  RAISE EXCEPTION 'Production schema or keyword rules missing; refusing migration';
 END IF;
END $guard$;
${up}
DO $guard$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY[${TABLES.map(t=>"'"+t+"'").join(',')}] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN
   RAISE EXCEPTION 'Missing production table or RLS: %',t;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_staging_app') THEN
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM crm_staging_app',t);
  END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','crm_staging_app'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) AND
      has_table_privilege(r,format('public.%I',t),'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Unexpected production experiment table access: %/%',r,t;
   END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_staging_app') THEN
  REVOKE ALL ON SEQUENCE public.keyword_reply_experiments_id_seq,
    public.keyword_reply_experiment_deliveries_id_seq, public.keyword_reply_experiment_clicks_id_seq FROM crm_staging_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class target ON target.oid=k.confrelid
   JOIN pg_namespace tn ON tn.oid=target.relnamespace
   WHERE n.nspname='public' AND c.relname IN (${TABLES.map(t=>"'"+t+"'").join(',')})
     AND k.contype='f' AND tn.nspname<>'public') THEN
  RAISE EXCEPTION 'Production experiment foreign key escapes schema';
 END IF;
END $guard$;`;
}
if(require.main===module)process.stdout.write(buildProductionMigration());
module.exports={buildProductionMigration};
