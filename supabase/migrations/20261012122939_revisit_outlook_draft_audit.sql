-- Expand audit vocabulary only. No customer data or delivery state is changed.
DO $$ BEGIN
  IF current_schema() NOT IN ('public','crm_staging') THEN RAISE EXCEPTION 'Explicit public/crm_staging search_path required'; END IF;
END $$;
ALTER TABLE revisit_email_recipient_events DROP CONSTRAINT IF EXISTS revisit_email_recipient_events_event_type_check;
ALTER TABLE revisit_email_recipient_events ADD CONSTRAINT revisit_email_recipient_events_event_type_check
  CHECK (event_type IN ('manual_confirm_sent','manual_retry','manual_cancel','auto_hard_bounce','outlook_draft_requested'));
