-- Cover the existing revisit-email foreign keys reported by the database advisor.
CREATE INDEX IF NOT EXISTS revisit_email_bookings_import_idx
  ON public.revisit_email_bookings (import_id)
  WHERE import_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revisit_email_offers_import_idx
  ON public.revisit_email_offers (import_id)
  WHERE import_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revisit_email_recipients_offer_idx
  ON public.revisit_email_recipients (offer_id)
  WHERE offer_id IS NOT NULL;
