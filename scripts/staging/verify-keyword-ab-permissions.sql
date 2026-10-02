-- Connect as crm_staging_app (or an administrator permitted to SET ROLE) in ONE connection.
-- Supabase's postgres management connection may not have SET ROLE permission.
-- All synthetic rows are rolled back.
-- Explicit negative IDs avoid advancing shared sequences during the remote probe.
BEGIN;
SET LOCAL search_path = crm_staging;
SET LOCAL statement_timeout = '15s';
SET LOCAL ROLE crm_staging_app;
DO $probe$
DECLARE
  table_name text;
  changed integer;
BEGIN
  IF current_user <> 'crm_staging_app' OR current_schema() <> 'crm_staging' THEN
    RAISE EXCEPTION 'Wrong staging role/schema';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Probe must exercise RLS';
  END IF;
  INSERT INTO keyword_reply_experiments
    (id,name,variant_a_config,variant_b_config,start_at,end_at)
    VALUES (-202610020901,'STAGING permission probe','{}','{}',now(),now()+interval '1 day');
  INSERT INTO keyword_reply_experiment_assignments (experiment_id,line_user_id,variant)
    VALUES (-202610020901,'STAGING_SYNTHETIC_PERMISSION_PROBE','a');
  INSERT INTO keyword_reply_experiment_deliveries
    (id,experiment_id,line_user_id,variant,webhook_event_id,delivery_code)
    VALUES (-202610020902,-202610020901,'STAGING_SYNTHETIC_PERMISSION_PROBE','a',
      'STAGING_SYNTHETIC_PERMISSION_EVENT','STAGING_SYNTHETIC_PERMISSION_CODE');
  INSERT INTO keyword_reply_experiment_clicks
    (id,delivery_id,experiment_id,variant,line_user_id,target_index)
    VALUES (-202610020903,-202610020902,-202610020901,'a','STAGING_SYNTHETIC_PERMISSION_PROBE',0);
  FOREACH table_name IN ARRAY ARRAY['keyword_reply_experiments',
    'keyword_reply_experiment_assignments','keyword_reply_experiment_deliveries',
    'keyword_reply_experiment_clicks'] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %s', table_name,
      CASE WHEN table_name='keyword_reply_experiments' THEN 'id=-202610020901'
      ELSE 'experiment_id=-202610020901' END) INTO changed;
    IF changed <> 1 THEN RAISE EXCEPTION 'RLS SELECT failed: %',table_name; END IF;
    EXECUTE format('UPDATE %I SET %I=%I WHERE %s',table_name,
      CASE WHEN table_name='keyword_reply_experiments' THEN 'name' ELSE 'variant' END,
      CASE WHEN table_name='keyword_reply_experiments' THEN 'name' ELSE 'variant' END,
      CASE WHEN table_name='keyword_reply_experiments' THEN 'id=-202610020901'
      ELSE 'experiment_id=-202610020901' END);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'RLS UPDATE failed: %',table_name; END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['keyword_reply_experiment_clicks',
    'keyword_reply_experiment_deliveries','keyword_reply_experiment_assignments',
    'keyword_reply_experiments'] LOOP
    EXECUTE format('DELETE FROM %I WHERE %s',table_name,
      CASE WHEN table_name='keyword_reply_experiments' THEN 'id=-202610020901'
      ELSE 'experiment_id=-202610020901' END);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'RLS DELETE failed: %',table_name; END IF;
  END LOOP;
END $probe$;
SELECT 'PASS: staging role CRUD on all four RLS tables; no LINE API calls' AS verification;
ROLLBACK;
