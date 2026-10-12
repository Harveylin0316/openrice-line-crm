-- Only use after reverting the webhook redirect and stopping worker/scheduler.
-- Never delete a nonempty durable inbox to roll back code.
DO $$ BEGIN
 IF current_schema() NOT IN ('public','crm_staging') THEN RAISE EXCEPTION 'Unexpected schema'; END IF;
 IF EXISTS(SELECT 1 FROM line_webhook_inbox) THEN RAISE EXCEPTION 'Inbox contains events; retain it'; END IF;
END $$;
DROP TABLE line_webhook_inbox;
