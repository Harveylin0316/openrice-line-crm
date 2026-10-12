-- Only an empty newly-created table may be removed. Preserve saved templates.
DO $$ BEGIN
  IF current_schema() NOT IN ('public','crm_staging') THEN RAISE EXCEPTION 'Explicit schema required'; END IF;
  IF EXISTS (SELECT 1 FROM revisit_email_templates LIMIT 1) THEN RAISE EXCEPTION 'Saved templates exist; retain table and revert code only'; END IF;
END $$;
DROP TABLE revisit_email_templates;
