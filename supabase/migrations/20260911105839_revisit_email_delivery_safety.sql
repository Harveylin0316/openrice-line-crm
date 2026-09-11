-- Delivery safety controls for booking revisit email.
-- Customer email addresses and delivery snapshots are server-side only.

ALTER TABLE public.revisit_email_campaigns
  ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1
    CHECK (content_version >= 1),
  ADD COLUMN IF NOT EXISTS tested_version INTEGER
    CHECK (tested_version IS NULL OR tested_version >= 1),
  ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_tested_email TEXT,
  ADD COLUMN IF NOT EXISTS last_test_recipient_id BIGINT;

CREATE TABLE IF NOT EXISTS public.revisit_email_test_deliveries (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES public.revisit_email_campaigns(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES public.revisit_email_recipients(id) ON DELETE CASCADE,
  test_email TEXT NOT NULL,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  tracking_token TEXT NOT NULL UNIQUE,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  cta_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  provider_message_id TEXT,
  failure_detail TEXT,
  tested_by TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS revisit_email_test_deliveries_campaign_idx
  ON public.revisit_email_test_deliveries (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS revisit_email_test_deliveries_recipient_idx
  ON public.revisit_email_test_deliveries (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.revisit_email_recipient_events (
  id BIGSERIAL PRIMARY KEY,
  recipient_id BIGINT NOT NULL REFERENCES public.revisit_email_recipients(id) ON DELETE CASCADE,
  campaign_id BIGINT NOT NULL REFERENCES public.revisit_email_campaigns(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'manual_confirm_sent', 'manual_retry', 'manual_cancel', 'auto_hard_bounce'
  )),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  acted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS revisit_email_recipient_events_recipient_idx
  ON public.revisit_email_recipient_events (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS revisit_email_recipient_events_campaign_idx
  ON public.revisit_email_recipient_events (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.revisit_email_suppressions (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  source TEXT NOT NULL CHECK (source IN ('smtp_rejection', 'admin', 'provider_webhook')),
  detail TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email_normalized = LOWER(BTRIM(email)))
);

CREATE INDEX IF NOT EXISTS revisit_email_suppressions_active_updated_idx
  ON public.revisit_email_suppressions (updated_at DESC)
  WHERE active = TRUE;

ALTER TABLE public.revisit_email_test_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_recipient_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_suppressions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.revisit_email_test_deliveries,
  public.revisit_email_recipient_events, public.revisit_email_suppressions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.revisit_email_test_deliveries_id_seq,
  public.revisit_email_recipient_events_id_seq, public.revisit_email_suppressions_id_seq
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  table_name TEXT;
  sequence_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'revisit_email_test_deliveries', 'revisit_email_recipient_events',
      'revisit_email_suppressions'
    ] LOOP
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
      EXECUTE format('DROP POLICY IF EXISTS app_server_full_access ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY app_server_full_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        table_name
      );
    END LOOP;
    FOREACH sequence_name IN ARRAY ARRAY[
      'revisit_email_test_deliveries_id_seq', 'revisit_email_recipient_events_id_seq',
      'revisit_email_suppressions_id_seq'
    ] LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', sequence_name);
    END LOOP;
  END IF;
END $$;
