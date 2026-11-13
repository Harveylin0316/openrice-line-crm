-- STAGING ONLY. Run as the owner of crm_staging.admin_flow_nodes.
-- Expands the verified five-type constraint; no rows, grants, RLS, or public schema changes.
-- Transactional and repeatable. Lock timeout prevents waiting indefinitely on live work.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE crm_staging.admin_flow_nodes IN ACCESS EXCLUSIVE MODE;
ALTER TABLE crm_staging.admin_flow_nodes
  DROP CONSTRAINT admin_flow_nodes_type_check;
ALTER TABLE crm_staging.admin_flow_nodes
  ADD CONSTRAINT admin_flow_nodes_type_check
  CHECK (type IN ('send','wait','branch','end','add_to_list','ab_split','add_tag','remove_tag'));
COMMIT;

SELECT conname, pg_get_constraintdef(oid) AS definition, convalidated
FROM pg_constraint
WHERE conrelid = 'crm_staging.admin_flow_nodes'::regclass
  AND conname = 'admin_flow_nodes_type_check';
