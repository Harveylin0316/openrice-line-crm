-- Keep recipient-level engagement in sync with the existing append-only
-- click/view logs. Campaign Performance and dynamic audiences can then use a
-- fast per-recipient field while historical rows remain recoverable from logs.
ALTER TABLE admin_broadcast_recipients
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_clicked_at timestamptz;

CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_opened_idx
  ON admin_broadcast_recipients (broadcast_id, opened_at)
  WHERE opened_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_clicked_idx
  ON admin_broadcast_recipients (broadcast_id, first_clicked_at)
  WHERE first_clicked_at IS NOT NULL;
