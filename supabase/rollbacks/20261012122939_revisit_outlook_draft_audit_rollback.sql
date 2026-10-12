-- Revert app first. Preserve audit rows; never delete them to allow rollback.
DO $$ BEGIN
  IF current_schema() NOT IN ('public','crm_staging') THEN RAISE EXCEPTION 'Explicit public/crm_staging search_path required'; END IF;
  IF EXISTS(SELECT 1 FROM revisit_email_recipient_events WHERE event_type='outlook_draft_requested')
    THEN RAISE EXCEPTION 'Outlook audit exists: retain expanded constraint'; END IF;
END $$;
ALTER TABLE revisit_email_recipient_events DROP CONSTRAINT IF EXISTS revisit_email_recipient_events_event_type_check;
ALTER TABLE revisit_email_recipient_events ADD CONSTRAINT revisit_email_recipient_events_event_type_check
  CHECK(event_type IN ('manual_confirm_sent','manual_retry','manual_cancel','auto_hard_bounce'));
