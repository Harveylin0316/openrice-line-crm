-- Apply using an explicitly selected schema, never runtime DDL.
CREATE TABLE IF NOT EXISTS crm_message_executions (
 id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE,
 source_type TEXT NOT NULL CHECK(source_type IN ('welcome','broadcast','automation','keyword')),
 source_id BIGINT NOT NULL, source_event_id TEXT NOT NULL, recipient_key TEXT NOT NULL,
 message_snapshot JSONB NOT NULL, targets JSONB NOT NULL DEFAULT '[]', variant TEXT,
 revision BIGINT NOT NULL DEFAULT 1, test_only BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','rejected','uncertain','skipped')),
 reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
 UNIQUE(source_type,source_id,source_event_id,recipient_key)
);
CREATE INDEX IF NOT EXISTS crm_message_executions_source_time ON crm_message_executions(source_type,source_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS crm_message_executions_time ON crm_message_executions(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS crm_message_clicks (
 id BIGSERIAL PRIMARY KEY,execution_id BIGINT NOT NULL REFERENCES crm_message_executions(id),
 action_index INT NOT NULL CHECK(action_index>=0),verified_identity TEXT,event_key TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(execution_id,event_key)
);
CREATE INDEX IF NOT EXISTS crm_message_clicks_execution ON crm_message_clicks(execution_id,action_index,occurred_at);
CREATE TABLE IF NOT EXISTS crm_welcome_settings (
 id INT PRIMARY KEY CHECK(id=1),enabled BOOLEAN NOT NULL DEFAULT false,
 first_enabled BOOLEAN NOT NULL DEFAULT true,unblocked_enabled BOOLEAN NOT NULL DEFAULT false,
 message_id BIGINT,message_name TEXT,message_snapshot JSONB,revision BIGINT NOT NULL DEFAULT 1,
 managed_flow_id BIGINT,updated_by TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO crm_welcome_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
DO $$ DECLARE t TEXT; r TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['crm_message_executions','crm_message_clicks','crm_welcome_settings'] LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',current_schema(),t);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',current_schema(),t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',current_schema(),t,r); END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['service_role','crm_staging_app'] LOOP
   IF (r='service_role' OR current_schema()='crm_staging') AND EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
    IF r='crm_staging_app' AND EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Staging role must not bypass RLS'; END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.%I TO %I',current_schema(),t,r);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I','crm_messages_'||r,current_schema(),t);
    EXECUTE format('CREATE POLICY %I ON %I.%I FOR ALL TO %I USING(true) WITH CHECK(true)','crm_messages_'||r,current_schema(),t,r);
   END IF;
  END LOOP;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['crm_message_executions_id_seq','crm_message_clicks_id_seq'] LOOP
  EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM PUBLIC',current_schema(),t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM %I',current_schema(),t,r); END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['service_role','crm_staging_app'] LOOP
   IF (r='service_role' OR current_schema()='crm_staging') AND EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %I.%I TO %I',current_schema(),t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
