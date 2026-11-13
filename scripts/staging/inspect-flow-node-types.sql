-- Read-only: inspect staging CHECK constraints before proposing an exact migration.
-- No users, credentials, or message contents are returned. Do not run against production.
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'crm_staging'
  AND t.relname = 'admin_flow_nodes'
  AND c.contype = 'c'
ORDER BY c.conname;

SELECT type, count(*) AS node_count
FROM crm_staging.admin_flow_nodes
GROUP BY type ORDER BY type;
