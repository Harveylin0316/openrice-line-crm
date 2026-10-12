-- Set search_path explicitly to public (production) or crm_staging before applying.
DO $$ BEGIN
 IF current_schema() NOT IN ('public','crm_staging') THEN RAISE EXCEPTION 'Unexpected schema'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS line_webhook_inbox (
 event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 200),
 payload JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','uncertain')),
 received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, reason TEXT
);
CREATE INDEX IF NOT EXISTS line_webhook_inbox_pending ON line_webhook_inbox(received_at,event_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS line_webhook_inbox_processing ON line_webhook_inbox(started_at) WHERE status='processing';
ALTER TABLE line_webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON line_webhook_inbox FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON line_webhook_inbox FROM %I',r); END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['service_role','crm_staging_app'] LOOP
  IF (r='service_role' OR current_schema()='crm_staging') AND EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   IF r='crm_staging_app' AND EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe staging role'; END IF;
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON line_webhook_inbox TO %I',r);
   EXECUTE format('DROP POLICY IF EXISTS %I ON line_webhook_inbox','webhook_inbox_'||r);
   EXECUTE format('CREATE POLICY %I ON line_webhook_inbox FOR ALL TO %I USING(true) WITH CHECK(true)','webhook_inbox_'||r,r);
  END IF;
 END LOOP;
END $$;
