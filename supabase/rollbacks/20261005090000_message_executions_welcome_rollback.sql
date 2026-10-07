-- Disable new writers and back up data first. Keep tables/readers when any sent links still exist.
DO $$ BEGIN
 IF EXISTS(SELECT FROM crm_message_executions) OR EXISTS(SELECT FROM crm_message_clicks) THEN
  RAISE EXCEPTION 'Execution history exists: preserve tracking tables and revert writers only';
 END IF;
 IF EXISTS(SELECT FROM crm_welcome_settings WHERE enabled OR managed_flow_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Disable and retire the managed welcome flow before schema rollback';
 END IF;
END $$;
DROP TABLE crm_message_clicks;
DROP TABLE crm_message_executions;
DROP TABLE crm_welcome_settings;
