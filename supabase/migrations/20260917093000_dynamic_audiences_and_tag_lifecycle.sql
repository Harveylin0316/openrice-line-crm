-- Dynamic audiences are stored on the existing recipient-list record so every
-- downstream sender can continue to consume one reviewed, materialised list.
ALTER TABLE admin_recipient_lists
  ADD COLUMN IF NOT EXISTS list_type text NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS definition jsonb,
  ADD COLUMN IF NOT EXISTS auto_refresh boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_status text,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_recipient_lists_list_type_check'
      AND conrelid = 'admin_recipient_lists'::regclass
  ) THEN
    ALTER TABLE admin_recipient_lists
      ADD CONSTRAINT admin_recipient_lists_list_type_check
      CHECK (list_type IN ('static', 'dynamic'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS admin_recipient_lists_dynamic_refresh_idx
  ON admin_recipient_lists (auto_refresh, id)
  WHERE list_type = 'dynamic';

-- A manual tag can expire; an automatic tag remembers the rule that owns it,
-- allowing that rule to remove the tag when the user stops matching.
ALTER TABLE user_tag_members
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_rule_id bigint REFERENCES user_tag_rules(id) ON DELETE SET NULL;

ALTER TABLE user_tag_rules
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'add',
  ADD COLUMN IF NOT EXISTS member_ttl_days integer,
  ADD COLUMN IF NOT EXISTS reconcile boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_removed integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_tag_rules_action_check'
      AND conrelid = 'user_tag_rules'::regclass
  ) THEN
    ALTER TABLE user_tag_rules
      ADD CONSTRAINT user_tag_rules_action_check CHECK (action IN ('add', 'remove'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_tag_rules_member_ttl_days_check'
      AND conrelid = 'user_tag_rules'::regclass
  ) THEN
    ALTER TABLE user_tag_rules
      ADD CONSTRAINT user_tag_rules_member_ttl_days_check
      CHECK (member_ttl_days IS NULL OR member_ttl_days BETWEEN 1 AND 3650);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_tag_members_expiry_idx
  ON user_tag_members (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_tag_members_source_rule_idx
  ON user_tag_members (source_rule_id)
  WHERE source_rule_id IS NOT NULL;

-- Keep provider acceptance (sent) separate from a provider-confirmed Email
-- delivery event. LINE Messaging API does not expose per-user delivery/open.
ALTER TABLE admin_broadcast_recipients
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_delivered_idx
  ON admin_broadcast_recipients (broadcast_id, delivered_at)
  WHERE delivered_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity_user_events (
  id bigserial PRIMARY KEY,
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  event_name text NOT NULL CHECK (event_name IN ('enter','start','complete','share')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_events_lookup_idx
  ON activity_user_events (activity_id, event_name, line_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS activity_user_events_play_key_unique
  ON activity_user_events (activity_id, line_user_id, event_name, (metadata->>'play_key'))
  WHERE metadata ? 'play_key';
ALTER TABLE activity_user_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE activity_user_events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE activity_user_events_id_seq FROM anon, authenticated;

-- These tables contain CRM identity/segmentation data and must never be
-- callable directly with Supabase anon/authenticated keys.
ALTER TABLE admin_recipient_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_recipient_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tag_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tag_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin_recipient_lists FROM anon, authenticated;
REVOKE ALL ON TABLE admin_recipient_list_members FROM anon, authenticated;
REVOKE ALL ON TABLE user_tag_members FROM anon, authenticated;
REVOKE ALL ON TABLE user_tag_rules FROM anon, authenticated;
REVOKE ALL ON TABLE activity_user_events FROM anon, authenticated;

GRANT ALL ON TABLE activity_user_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE activity_user_events_id_seq TO service_role;
DROP POLICY IF EXISTS activity_user_events_service_all ON activity_user_events;
CREATE POLICY activity_user_events_service_all ON activity_user_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
