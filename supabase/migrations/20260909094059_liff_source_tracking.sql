-- 通用 LIFF 來源追蹤。
-- 設定與事件都只由 server-side PostgreSQL 連線存取，不對 Data API 開放。

CREATE TABLE IF NOT EXISTS liff_tracking_links (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  campaign_name TEXT NOT NULL CHECK (char_length(campaign_name) BETWEEN 1 AND 100),
  source_key TEXT NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  source_label TEXT NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 60),
  target_url TEXT NOT NULL CHECK (target_url ~ '^https://'),
  conversion_type TEXT NOT NULL DEFAULT 'none'
    CHECK (conversion_type IN ('none', 'activity_play', 'user_event')),
  conversion_key TEXT,
  attribution_days INTEGER NOT NULL DEFAULT 7 CHECK (attribution_days BETWEEN 1 AND 365),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (conversion_type = 'none' AND conversion_key IS NULL)
    OR (conversion_type <> 'none' AND conversion_key IS NOT NULL AND char_length(conversion_key) BETWEEN 1 AND 100)
  )
);

CREATE TABLE IF NOT EXISTS liff_tracking_events (
  id BIGSERIAL PRIMARY KEY,
  tracking_link_id BIGINT NOT NULL REFERENCES liff_tracking_links(id) ON DELETE RESTRICT,
  line_user_id TEXT NOT NULL CHECK (line_user_id ~ '^U[0-9A-Fa-f]{32}$'),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedupe_minute TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
  UNIQUE (tracking_link_id, line_user_id, dedupe_minute)
);

CREATE INDEX IF NOT EXISTS idx_liff_tracking_events_link_time
  ON liff_tracking_events (tracking_link_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_liff_tracking_events_user_time
  ON liff_tracking_events (line_user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_liff_tracking_links_status
  ON liff_tracking_links (status, created_at DESC);

ALTER TABLE liff_tracking_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE liff_tracking_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE liff_tracking_links, liff_tracking_events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE liff_tracking_links_id_seq, liff_tracking_events_id_seq FROM anon, authenticated;
