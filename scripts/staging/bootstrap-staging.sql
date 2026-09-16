-- LINE CRM staging bootstrap (run from Supabase SQL Editor as project owner)
-- Replace the two placeholders only in the SQL Editor. Never commit real passwords.
-- This creates an isolated schema and a least-privilege login for Netlify previews.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_staging_app') THEN
    CREATE ROLE crm_staging_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE crm_staging_app PASSWORD '__STAGING_DB_PASSWORD__';
ALTER ROLE crm_staging_app SET search_path = crm_staging, extensions;
ALTER ROLE crm_staging_app SET statement_timeout = '15s';

CREATE SCHEMA IF NOT EXISTS crm_staging AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA crm_staging FROM PUBLIC;
GRANT USAGE ON SCHEMA crm_staging TO crm_staging_app;

-- Clone structure only. Production rows are never copied.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS crm_staging.%I (LIKE public.%I INCLUDING ALL)',
      r.tablename,
      r.tablename
    );
  END LOOP;
END $$;

-- LIKE copies SERIAL defaults pointing at public sequences. Replace each with a private sequence.
DO $$
DECLARE
  r record;
  staging_sequence text;
BEGIN
  FOR r IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_default LIKE 'nextval(%'
     ORDER BY table_name, ordinal_position
  LOOP
    staging_sequence := r.table_name || '_' || r.column_name || '_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS crm_staging.%I', staging_sequence);
    EXECUTE format(
      'ALTER TABLE crm_staging.%I ALTER COLUMN %I SET DEFAULT nextval(%L::regclass)',
      r.table_name,
      r.column_name,
      'crm_staging.' || staging_sequence
    );
    EXECUTE format(
      'ALTER SEQUENCE crm_staging.%I OWNED BY crm_staging.%I.%I',
      staging_sequence,
      r.table_name,
      r.column_name
    );
  END LOOP;
END $$;

-- Recreate only foreign keys whose source and target are both app tables in public.
DO $$
DECLARE
  r record;
  definition text;
BEGIN
  FOR r IN
    SELECT c.conname,
           source.relname AS source_table,
           pg_get_constraintdef(c.oid) AS constraint_definition
      FROM pg_constraint c
      JOIN pg_class source ON source.oid = c.conrelid
      JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
      JOIN pg_class target ON target.oid = c.confrelid
      JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
     WHERE c.contype = 'f'
       AND source_ns.nspname = 'public'
       AND target_ns.nspname = 'public'
     ORDER BY source.relname, c.conname
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint existing
        JOIN pg_class tbl ON tbl.oid = existing.conrelid
        JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
       WHERE ns.nspname = 'crm_staging'
         AND tbl.relname = r.source_table
         AND existing.conname = r.conname
    ) THEN
      -- pg_get_constraintdef may omit `public.` when it is already on search_path.
      -- Prefix the referenced table in either form so no FK can point back to production.
      definition := regexp_replace(
        r.constraint_definition,
        'REFERENCES (public\\.)?',
        'REFERENCES crm_staging.'
      );
      EXECUTE format(
        'ALTER TABLE crm_staging.%I ADD CONSTRAINT %I %s',
        r.source_table,
        r.conname,
        definition
      );
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm_staging TO crm_staging_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA crm_staging TO crm_staging_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm_staging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_staging_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm_staging
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO crm_staging_app;

-- Synthetic-only seed data. No LINE user id, email, coupon, booking, or production row is copied.
INSERT INTO crm_staging.users
  (username, password_hash, draws_left, extra_draws, is_admin, role, is_active)
VALUES
  ('staging-admin', extensions.crypt('__STAGING_ADMIN_PASSWORD__', extensions.gen_salt('bf')), 1, 0, TRUE, 'admin', TRUE)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  is_admin = TRUE,
  role = 'admin',
  is_active = TRUE,
  sess_epoch = crm_staging.users.sess_epoch + 1;

INSERT INTO crm_staging.campaign_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm_staging.prizes (name, quantity)
SELECT seed.name, seed.quantity
  FROM (VALUES
    ('STAGING｜26,000 里', 3),
    ('STAGING｜Rice Dollar $100', 20),
    ('STAGING｜銘謝惠顧', 999)
  ) AS seed(name, quantity)
 WHERE NOT EXISTS (SELECT 1 FROM crm_staging.prizes);

-- Assertions: fail the script if the role can read production users or staging is incomplete.
DO $$
BEGIN
  IF has_table_privilege('crm_staging_app', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'unsafe staging role: production public.users is readable';
  END IF;
  IF NOT has_table_privilege('crm_staging_app', 'crm_staging.users', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'staging role is missing required crm_staging.users privileges';
  END IF;
END $$;

SELECT
  current_database() AS database_name,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'crm_staging') AS staging_table_count,
  has_table_privilege('crm_staging_app', 'public.users', 'SELECT') AS can_read_production_users,
  has_table_privilege('crm_staging_app', 'crm_staging.users', 'SELECT') AS can_read_staging_users;
