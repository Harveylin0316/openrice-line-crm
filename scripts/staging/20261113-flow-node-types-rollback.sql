-- STAGING ONLY. Never deletes or rewrites flows to force a rollback.
-- Pause affected flows and coordinate removal/conversion through the normal product workflow first.
-- If any new-type nodes remain (even in drafts), this transaction fails without changing the constraint.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE crm_staging.admin_flow_nodes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm_staging.admin_flow_nodes
             WHERE type NOT IN ('send','wait','branch','end','add_to_list')) THEN
    RAISE EXCEPTION 'rollback blocked: new-type flow nodes remain; preserve data and resolve affected flows first';
  END IF;
END $$;
ALTER TABLE crm_staging.admin_flow_nodes
  DROP CONSTRAINT admin_flow_nodes_type_check;
ALTER TABLE crm_staging.admin_flow_nodes
  ADD CONSTRAINT admin_flow_nodes_type_check
  CHECK (type IN ('send','wait','branch','end','add_to_list'));
COMMIT;
