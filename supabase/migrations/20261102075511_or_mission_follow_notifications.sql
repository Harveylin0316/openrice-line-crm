-- Phase 1 is staging-only. Explicit SET LOCAL search_path=crm_staging is required.
-- No runtime DDL, triggers, jobs, historical backfill or external HTTP.
DO $$ BEGIN
  IF current_schema() <> 'crm_staging' THEN
    RAISE EXCEPTION 'OR mission phase 1 requires crm_staging schema';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS or_mission_follow_notifications (
  id BIGSERIAL PRIMARY KEY,
  webhook_event_id TEXT NOT NULL UNIQUE CHECK(length(webhook_event_id) BETWEEN 1 AND 200),
  line_user_id TEXT NOT NULL CHECK(line_user_id ~ '^U[0-9a-fA-F]{32}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  is_unblocked BOOLEAN,
  status TEXT NOT NULL DEFAULT 'captured' CHECK(status IN
    ('captured','sending','http_accepted_unverified','http_rejected','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
  http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS or_mission_follow_captured ON or_mission_follow_notifications(id)
  WHERE status='captured' AND attempts=0;
ALTER TABLE or_mission_follow_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON or_mission_follow_notifications FROM PUBLIC;
REVOKE ALL ON SEQUENCE or_mission_follow_notifications_id_seq FROM PUBLIC;

DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON crm_staging.or_mission_follow_notifications FROM %I',r);
      EXECUTE format('REVOKE ALL ON SEQUENCE crm_staging.or_mission_follow_notifications_id_seq FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='crm_staging_app') THEN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='crm_staging_app' AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Staging role must not bypass RLS';
    END IF;
    GRANT SELECT,INSERT,UPDATE ON or_mission_follow_notifications TO crm_staging_app;
    GRANT USAGE,SELECT ON SEQUENCE or_mission_follow_notifications_id_seq TO crm_staging_app;
    DROP POLICY IF EXISTS or_mission_staging_app ON or_mission_follow_notifications;
    CREATE POLICY or_mission_staging_app ON or_mission_follow_notifications
      FOR ALL TO crm_staging_app USING(true) WITH CHECK(true);
  END IF;
END $$;
