-- Booking-record driven revisit email campaigns.
-- All access is server-side through the CRM PostgreSQL connection. Customer
-- email addresses and message snapshots must never be exposed through the
-- Supabase Data API.

CREATE TABLE IF NOT EXISTS public.revisit_email_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revisit_after_days INTEGER NOT NULL DEFAULT 30 CHECK (revisit_after_days BETWEEN 1 AND 365),
  same_restaurant_cooldown_days INTEGER NOT NULL DEFAULT 60 CHECK (same_restaurant_cooldown_days BETWEEN 1 AND 730),
  global_cooldown_days INTEGER NOT NULL DEFAULT 7 CHECK (global_cooldown_days BETWEEN 0 AND 365),
  min_offer_days_remaining INTEGER NOT NULL DEFAULT 7 CHECK (min_offer_days_remaining BETWEEN 0 AND 365),
  daily_send_limit INTEGER NOT NULL DEFAULT 200 CHECK (daily_send_limit BETWEEN 1 AND 1000),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.revisit_email_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.revisit_email_imports (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bookings', 'offers')),
  source_file TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'completed', 'failed')),
  received_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  error_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.revisit_email_bookings (
  id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'weekly_csv',
  external_booking_id TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  dining_date DATE NOT NULL,
  booking_status TEXT NOT NULL CHECK (booking_status IN ('completed', 'cancelled', 'no_show', 'unknown')),
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  booking_url TEXT,
  source_file TEXT,
  import_id BIGINT REFERENCES public.revisit_email_imports(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_system, external_booking_id)
);

CREATE TABLE IF NOT EXISTS public.revisit_email_offers (
  id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'weekly_csv',
  external_offer_id TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  offer_type TEXT NOT NULL CHECK (offer_type IN ('discount', 'set_menu', 'other')),
  title TEXT NOT NULL,
  description TEXT,
  discount_label TEXT,
  price_label TEXT,
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,
  cta_url TEXT NOT NULL,
  terms TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source_file TEXT,
  import_id BIGINT REFERENCES public.revisit_email_imports(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (valid_until >= valid_from),
  UNIQUE (source_system, external_offer_id)
);

CREATE TABLE IF NOT EXISTS public.revisit_email_campaigns (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'completed', 'cancelled')),
  as_of_date DATE NOT NULL,
  settings_snapshot JSONB NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  excluded_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.revisit_email_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES public.revisit_email_campaigns(id) ON DELETE CASCADE,
  booking_id BIGINT NOT NULL REFERENCES public.revisit_email_bookings(id) ON DELETE RESTRICT,
  offer_id BIGINT REFERENCES public.revisit_email_offers(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  restaurant_id TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  offer_snapshot JSONB,
  subject TEXT NOT NULL,
  preheader TEXT,
  body_html TEXT NOT NULL,
  body_copy TEXT NOT NULL,
  body_text TEXT NOT NULL,
  cta_url TEXT NOT NULL,
  tracking_token TEXT NOT NULL UNIQUE,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'skipped', 'cancelled')),
  provider_message_id TEXT,
  failure_detail TEXT,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, booking_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS revisit_email_one_sent_per_booking_idx
  ON public.revisit_email_recipients (booking_id)
  WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS revisit_email_bookings_eligibility_idx
  ON public.revisit_email_bookings (booking_status, marketing_consent, dining_date DESC);
CREATE INDEX IF NOT EXISTS revisit_email_bookings_customer_restaurant_idx
  ON public.revisit_email_bookings (LOWER(customer_email), restaurant_id, dining_date DESC);
CREATE INDEX IF NOT EXISTS revisit_email_offers_match_idx
  ON public.revisit_email_offers (restaurant_id, is_active, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS revisit_email_recipients_campaign_status_idx
  ON public.revisit_email_recipients (campaign_id, status, id);
CREATE INDEX IF NOT EXISTS revisit_email_recipients_customer_sent_idx
  ON public.revisit_email_recipients (LOWER(recipient_email), sent_at DESC)
  WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS revisit_email_recipients_restaurant_sent_idx
  ON public.revisit_email_recipients (LOWER(recipient_email), restaurant_id, sent_at DESC)
  WHERE status = 'sent';

ALTER TABLE public.revisit_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisit_email_recipients ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.revisit_email_settings, public.revisit_email_imports,
  public.revisit_email_bookings, public.revisit_email_offers,
  public.revisit_email_campaigns, public.revisit_email_recipients
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.revisit_email_imports_id_seq,
  public.revisit_email_bookings_id_seq, public.revisit_email_offers_id_seq,
  public.revisit_email_campaigns_id_seq, public.revisit_email_recipients_id_seq
  FROM anon, authenticated;

DO $$
DECLARE
  table_name TEXT;
  sequence_name TEXT;
BEGIN
  -- The direct PostgreSQL owner used by the CRM bypasses RLS. Grant only the
  -- same server-side access to Supabase's service_role, when that role exists.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'revisit_email_settings', 'revisit_email_imports', 'revisit_email_bookings',
      'revisit_email_offers', 'revisit_email_campaigns', 'revisit_email_recipients'
    ] LOOP
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
      EXECUTE format('DROP POLICY IF EXISTS app_server_full_access ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY app_server_full_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        table_name
      );
    END LOOP;
    FOREACH sequence_name IN ARRAY ARRAY[
      'revisit_email_imports_id_seq', 'revisit_email_bookings_id_seq',
      'revisit_email_offers_id_seq', 'revisit_email_campaigns_id_seq',
      'revisit_email_recipients_id_seq'
    ] LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', sequence_name);
    END LOOP;
  END IF;
END $$;
