-- =============================================================================
-- OpenRice LINE CRM — public schema 快照（baseline）
--
-- 這份檔案是「線上 Supabase 目前長什麼樣」的完整快照，用途有兩個：
--   1. 從零架起一套可以跑的資料庫（本機開發、測試、災後重建）
--   2. 讓 repo 自己說得出 schema 是什麼——在這之前完全說不出來
--
-- 為什麼會需要這份東西：
--   歷來的 DDL 都是直接對 Supabase 下（dashboard / MCP apply_migration），
--   SQL 從來沒進版控。Supabase 的 supabase_migrations.schema_migrations 有
--   48 筆紀錄，repo 的 supabase/migrations/ 只有 2 個檔案。結果是：
--   拿這個 repo 從零開一套環境會整片 500——src/core/dbInit.js 只建得出
--   24 張舊表，activities / activity_plays / activity_referrals /
--   activity_user_quotas / activity_bonus_plays / activity_referral_attempts
--   全部沒有，users 也缺 archived_at、created_at、blocked_at 等欄位。
--
-- 用法：
--   psql "$DATABASE_URL" -f supabase/schema.sql
--   全部語句都可重複執行（IF NOT EXISTS / 先 DROP 再建），跑第二次是 no-op。
--
-- 不是什麼：
--   這不是 migration。它只會「補上不存在的東西」，不會改既有表的欄位。
--   對已經有舊版表的資料庫執行，不會幫你把缺的欄位加上去。
--   之後要改 schema，請在 supabase/migrations/ 寫新的 migration 檔案並進版控，
--   不要再直接對 Supabase 下 DDL。
--
-- 產生方式：讀 Supabase 專案 LINE CRM System 的 catalog（pg_class / pg_constraint
--   / pg_index / pg_policies / pg_proc / pg_trigger / pg_description）。
--   對照數字：51 張表、118 個約束、106 個非約束索引、27 條 policy、
--   2 個 view、2 個函式、3 個 trigger、13 條註解。
--
-- ⚠ RLS：線上有 23 張表沒有開 RLS（user_events、activities、activity_plays、
--   activity_referrals、activity_user_quotas、rfm_profiles、oa_contacts、
--   booking_source_answers、campaign_phone_registrations、admin_flow_* 等）。
--   這份快照忠實反映現況，沒有替它們補 RLS——補了但沒寫 policy 會直接把
--   應用程式擋死。要處理請另外評估，見 supabase/README.md。
-- =============================================================================

-- users.line_id_hash 是 STORED generated column，用到 pgcrypto 的 digest()。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activities (
  id bigserial,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  game_type text NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  cover_image_url text,
  rules jsonb DEFAULT '{}'::jsonb NOT NULL,
  daily_plays_per_user integer,
  require_follow_oa boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  liff_id_override text,
  base_plays_per_user integer DEFAULT 1 NOT NULL,
  referral_bonus_per integer DEFAULT 0 NOT NULL,
  referral_bonus_max integer DEFAULT 0 NOT NULL,
  referral_invites_per_bonus integer DEFAULT 1 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.activity_bonus_plays (
  id bigserial,
  activity_id bigint NOT NULL,
  line_user_id text NOT NULL,
  plays integer NOT NULL,
  reason text,
  granted_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.activity_plays (
  id bigserial,
  activity_id bigint NOT NULL,
  line_user_id text NOT NULL,
  line_display_name text,
  prize_id bigint,
  prize_snapshot jsonb DEFAULT '{}'::jsonb,
  is_redeemed boolean DEFAULT false,
  redeemed_at timestamp with time zone,
  properties jsonb DEFAULT '{}'::jsonb,
  played_at timestamp with time zone DEFAULT now() NOT NULL,
  coupon_code text
);

CREATE TABLE IF NOT EXISTS public.activity_prizes (
  id bigserial,
  activity_id bigint NOT NULL,
  name text NOT NULL,
  description text,
  image_url text,
  probability_weight numeric DEFAULT 1 NOT NULL,
  stock_total integer,
  stock_remaining integer,
  prize_type text DEFAULT 'badge'::text NOT NULL,
  prize_value jsonb DEFAULT '{}'::jsonb,
  "position" integer DEFAULT 0 NOT NULL,
  is_grand_prize boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.activity_referral_attempts (
  id bigserial,
  activity_slug text NOT NULL,
  game_type text NOT NULL,
  inviter_line_user_id text,
  invitee_line_user_id text,
  outcome text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.activity_referrals (
  id bigserial,
  activity_id bigint NOT NULL,
  inviter_line_user_id text NOT NULL,
  invitee_line_user_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  invitee_was_existing boolean
);

CREATE TABLE IF NOT EXISTS public.activity_user_quotas (
  id bigserial,
  activity_id bigint NOT NULL,
  line_user_id text NOT NULL,
  line_display_name text,
  max_plays_override integer NOT NULL,
  note text,
  granted_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_broadcast_clicks (
  id bigserial,
  broadcast_id bigint NOT NULL,
  target_url text NOT NULL,
  user_agent text,
  referer text,
  clicked_at timestamp with time zone DEFAULT now() NOT NULL,
  variant text,
  recipient_id bigint,
  line_user_id text,
  email text
);

CREATE TABLE IF NOT EXISTS public.admin_broadcast_recipients (
  id bigserial,
  broadcast_id bigint NOT NULL,
  user_id integer,
  line_user_id text,
  status text DEFAULT 'pending'::text NOT NULL,
  pushed_at timestamp with time zone,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  variant text DEFAULT 'a'::text NOT NULL,
  email text,
  provider_message_id text,
  opened_at timestamp with time zone,
  first_clicked_at timestamp with time zone,
  bounced_at timestamp with time zone,
  unsubscribed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.admin_broadcast_views (
  id bigserial,
  broadcast_id bigint NOT NULL,
  user_agent text,
  viewed_at timestamp with time zone DEFAULT now() NOT NULL,
  variant text,
  recipient_id bigint,
  line_user_id text,
  email text
);

CREATE TABLE IF NOT EXISTS public.admin_broadcasts (
  id bigserial,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  scheduled_at timestamp with time zone,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  admin_username text NOT NULL,
  audience_config jsonb NOT NULL,
  message_config jsonb NOT NULL,
  recipient_total integer DEFAULT 0 NOT NULL,
  recipient_ok integer DEFAULT 0 NOT NULL,
  recipient_fail integer DEFAULT 0 NOT NULL,
  recipient_skip integer DEFAULT 0 NOT NULL,
  is_ab_test boolean DEFAULT false NOT NULL,
  variant_b_message_config jsonb,
  channel text DEFAULT 'line'::text NOT NULL,
  email_subject text,
  email_from_name text,
  email_from_address text
);

CREATE TABLE IF NOT EXISTS public.admin_email_unsubscribes (
  id bigserial,
  email text NOT NULL,
  broadcast_id bigint,
  reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_flow_clicks (
  id bigserial,
  enrollment_id bigint,
  line_user_id text,
  message_id bigint,
  target_url text,
  clicked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_flow_enrollments (
  id bigserial,
  flow_id bigint NOT NULL,
  line_user_id text NOT NULL,
  user_id integer,
  current_node_key text,
  status text DEFAULT 'active'::text NOT NULL,
  next_run_at timestamp with time zone DEFAULT now() NOT NULL,
  context jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_message_id bigint,
  last_message_sent_at timestamp with time zone,
  enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  retry_count integer DEFAULT 0 NOT NULL,
  last_error text
);

CREATE TABLE IF NOT EXISTS public.admin_flow_event_cursor (
  flow_id bigint NOT NULL,
  last_event_id bigint DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_flow_nodes (
  id bigserial,
  flow_id bigint NOT NULL,
  node_key text NOT NULL,
  type text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  next_key text,
  branch_true_key text,
  branch_false_key text,
  is_entry boolean DEFAULT false NOT NULL,
  "position" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_flow_schedule_runs (
  id bigserial,
  flow_id bigint NOT NULL,
  period_key text NOT NULL,
  ran_at timestamp with time zone DEFAULT now() NOT NULL,
  enrolled_count integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_flows (
  id bigserial,
  name text NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  trigger_type text NOT NULL,
  trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  re_enroll boolean DEFAULT false NOT NULL,
  created_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_keyword_replies (
  id serial,
  keywords text NOT NULL,
  match_type text DEFAULT 'contains'::text NOT NULL,
  message_template_id bigint,
  is_active boolean DEFAULT true,
  priority integer DEFAULT 100,
  hit_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_login_throttle (
  id bigserial,
  ip_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_manual_bonus_logs (
  id bigserial,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  target_user_id integer NOT NULL,
  target_username text NOT NULL,
  bonus_count integer NOT NULL,
  adjust_extra boolean DEFAULT false NOT NULL,
  admin_username text NOT NULL,
  draws_left_after integer NOT NULL,
  extra_draws_after integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_message_templates (
  id bigserial,
  name text NOT NULL,
  description text,
  message_config jsonb NOT NULL,
  created_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  channel text DEFAULT 'line'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_push_settings (
  slug text NOT NULL,
  message_text text DEFAULT ''::text NOT NULL,
  image_media_id uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  flex_json jsonb
);

CREATE TABLE IF NOT EXISTS public.admin_recipient_list_members (
  id bigserial,
  list_id bigint NOT NULL,
  line_user_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  email text,
  display_name text
);

CREATE TABLE IF NOT EXISTS public.admin_recipient_lists (
  id bigserial,
  name text NOT NULL,
  description text,
  total integer DEFAULT 0 NOT NULL,
  created_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_test_recipients (
  id bigserial,
  label text NOT NULL,
  line_user_id text NOT NULL,
  added_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.booking_source_answers (
  id bigserial,
  line_user_id text NOT NULL,
  source_key text NOT NULL,
  source_label text NOT NULL,
  raw_text text NOT NULL,
  answered_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.campaign_draw_winners (
  id bigserial,
  campaign_key text NOT NULL,
  draw_batch text NOT NULL,
  phone_normalized text NOT NULL,
  line_user_id text,
  prize_label text,
  drawn_at timestamp with time zone DEFAULT now() NOT NULL,
  drawn_by text
);

CREATE TABLE IF NOT EXISTS public.campaign_phone_registrations (
  id bigserial,
  campaign_key text NOT NULL,
  line_user_id text NOT NULL,
  phone_normalized text NOT NULL,
  phone_raw text,
  registered_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.campaign_settings (
  id smallint DEFAULT 1 NOT NULL,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.coupon_codes (
  id serial,
  activity_id integer NOT NULL,
  prize_id integer,
  code text NOT NULL,
  status text DEFAULT 'available'::text NOT NULL,
  claimed_play_id integer,
  claimed_line_user_id text,
  claimed_at timestamp with time zone,
  redeemed_at timestamp with time zone,
  redeemed_by text,
  source text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.draw_logs (
  id serial,
  user_id integer NOT NULL,
  is_win boolean DEFAULT false NOT NULL,
  prize_name text,
  message text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gold_pig_booking_tokens (
  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  booking_id bigint NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gold_pig_bookings (
  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  booking_no text NOT NULL,
  status text DEFAULT 'confirmed'::text NOT NULL,
  is_demo boolean DEFAULT false NOT NULL,
  session_date date NOT NULL,
  session_time time without time zone NOT NULL,
  tables_4 integer DEFAULT 0 NOT NULL,
  tables_6 integer DEFAULT 0 NOT NULL,
  guest_count integer NOT NULL,
  total_amount integer NOT NULL,
  payment_method text,
  payment_reference text,
  contact_name text,
  contact_phone text,
  contact_email text,
  paid_at timestamp with time zone NOT NULL,
  line_user_id text,
  line_bound_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gold_pig_cancellation_requests (
  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  booking_id bigint NOT NULL,
  line_user_id text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  processed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.liff_asset_blobs (
  asset_key text NOT NULL,
  content bytea NOT NULL,
  mime_type text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.liff_token_probe (
  id bigserial,
  endpoint text,
  game_type text,
  slug text,
  body_line_user_id text,
  token_present boolean,
  verified boolean,
  verified_sub text,
  sub_matches boolean,
  channel_id text,
  detail text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.line_follow_sources (
  line_user_id text NOT NULL,
  source_key text NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.line_invites (
  id serial,
  inviter_user_id integer NOT NULL,
  invitee_line_user_id text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  followed_at timestamp with time zone,
  rewarded_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.line_push_logs (
  id serial,
  user_id integer,
  line_user_id text,
  push_type text DEFAULT 'winner_notification'::text NOT NULL,
  status text NOT NULL,
  http_status integer,
  detail text,
  payload jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.line_push_media (
  id uuid NOT NULL,
  mime_type text NOT NULL,
  body bytea NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.line_webhook_events (
  id serial,
  event_type text NOT NULL,
  line_user_id text,
  invite_id integer,
  inviter_user_id integer,
  result text NOT NULL,
  detail text,
  event_timestamp timestamp with time zone,
  raw_event jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.oa_contacts (
  id bigserial,
  oa_key text NOT NULL,
  line_user_id text NOT NULL,
  display_name text,
  picture_url text,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_event_at timestamp with time zone DEFAULT now() NOT NULL,
  blocked_at timestamp with time zone,
  profile_tried_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.prize_change_logs (
  id serial,
  action text NOT NULL,
  prize_id integer,
  before_name text,
  before_quantity integer,
  after_name text,
  after_quantity integer,
  admin_username text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.prizes (
  id serial,
  name text NOT NULL,
  quantity integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.restaurant_catalog (
  id serial,
  ref_key text NOT NULL,
  poi_id text,
  query text,
  display_name text,
  cuisine text,
  price_band text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.restaurant_trial_applications (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  application_code text NOT NULL,
  restaurant_name text NOT NULL,
  location text NOT NULL,
  contact_name text NOT NULL,
  phone text NOT NULL,
  phone_normalized text NOT NULL,
  preferred_contact_time text NOT NULL,
  current_booking_system text,
  primary_goal text,
  status text DEFAULT 'new'::text NOT NULL,
  source text DEFAULT 'landing_page'::text NOT NULL,
  utm jsonb DEFAULT '{}'::jsonb NOT NULL,
  landing_page_url text,
  consent_at timestamp with time zone DEFAULT now() NOT NULL,
  assigned_to text,
  internal_notes text,
  first_contacted_at timestamp with time zone,
  trial_started_at timestamp with time zone,
  converted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.rfm_profiles (
  rfm_user_id bigint NOT NULL,
  line_user_id text,
  phone text,
  email text,
  recency integer,
  frequency integer,
  monetary_est numeric,
  source text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_events (
  id bigserial,
  line_id text,
  session_id text NOT NULL,
  event_name text NOT NULL,
  properties jsonb DEFAULT '{}'::jsonb,
  is_in_line boolean,
  os text,
  language text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_restaurant_clicks (
  id bigserial,
  line_user_id text NOT NULL,
  restaurant_query text,
  poi_id text,
  cuisine text,
  target_url text,
  source text,
  clicked_at timestamp with time zone DEFAULT now() NOT NULL
);

-- line_id_hash 是 STORED generated column（不是 DEFAULT），依賴 pgcrypto 的 digest()。
CREATE TABLE IF NOT EXISTS public.users (
  id serial,
  username text NOT NULL,
  password_hash text NOT NULL,
  draws_left integer DEFAULT 1 NOT NULL,
  referrer_id integer,
  extra_draws integer DEFAULT 0 NOT NULL,
  is_admin boolean DEFAULT false NOT NULL,
  line_user_id text,
  line_display_name text,
  line_picture_url text,
  invite_code text,
  created_at timestamp with time zone DEFAULT now(),
  blocked_at timestamp with time zone,
  role text,
  is_active boolean DEFAULT true NOT NULL,
  sess_epoch integer DEFAULT 0 NOT NULL,
  archived_at timestamp with time zone,
  line_id_hash text GENERATED ALWAYS AS (
    CASE
      WHEN (line_user_id IS NULL) THEN NULL::text
      ELSE ('sha256:'::text || encode(digest(line_user_id, 'sha256'::text), 'hex'::text))
    END
  ) STORED
);

-- ── Constraints ────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activities_pkey' AND conrelid = 'public.activities'::regclass) THEN
    ALTER TABLE public.activities ADD CONSTRAINT activities_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_bonus_plays_pkey' AND conrelid = 'public.activity_bonus_plays'::regclass) THEN
    ALTER TABLE public.activity_bonus_plays ADD CONSTRAINT activity_bonus_plays_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_plays_pkey' AND conrelid = 'public.activity_plays'::regclass) THEN
    ALTER TABLE public.activity_plays ADD CONSTRAINT activity_plays_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_prizes_pkey' AND conrelid = 'public.activity_prizes'::regclass) THEN
    ALTER TABLE public.activity_prizes ADD CONSTRAINT activity_prizes_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_referral_attempts_pkey' AND conrelid = 'public.activity_referral_attempts'::regclass) THEN
    ALTER TABLE public.activity_referral_attempts ADD CONSTRAINT activity_referral_attempts_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_referrals_pkey' AND conrelid = 'public.activity_referrals'::regclass) THEN
    ALTER TABLE public.activity_referrals ADD CONSTRAINT activity_referrals_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_user_quotas_pkey' AND conrelid = 'public.activity_user_quotas'::regclass) THEN
    ALTER TABLE public.activity_user_quotas ADD CONSTRAINT activity_user_quotas_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_clicks_pkey' AND conrelid = 'public.admin_broadcast_clicks'::regclass) THEN
    ALTER TABLE public.admin_broadcast_clicks ADD CONSTRAINT admin_broadcast_clicks_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_recipients_pkey' AND conrelid = 'public.admin_broadcast_recipients'::regclass) THEN
    ALTER TABLE public.admin_broadcast_recipients ADD CONSTRAINT admin_broadcast_recipients_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_views_pkey' AND conrelid = 'public.admin_broadcast_views'::regclass) THEN
    ALTER TABLE public.admin_broadcast_views ADD CONSTRAINT admin_broadcast_views_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcasts_pkey' AND conrelid = 'public.admin_broadcasts'::regclass) THEN
    ALTER TABLE public.admin_broadcasts ADD CONSTRAINT admin_broadcasts_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_email_unsubscribes_pkey' AND conrelid = 'public.admin_email_unsubscribes'::regclass) THEN
    ALTER TABLE public.admin_email_unsubscribes ADD CONSTRAINT admin_email_unsubscribes_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_clicks_pkey' AND conrelid = 'public.admin_flow_clicks'::regclass) THEN
    ALTER TABLE public.admin_flow_clicks ADD CONSTRAINT admin_flow_clicks_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_enrollments_pkey' AND conrelid = 'public.admin_flow_enrollments'::regclass) THEN
    ALTER TABLE public.admin_flow_enrollments ADD CONSTRAINT admin_flow_enrollments_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_event_cursor_pkey' AND conrelid = 'public.admin_flow_event_cursor'::regclass) THEN
    ALTER TABLE public.admin_flow_event_cursor ADD CONSTRAINT admin_flow_event_cursor_pkey PRIMARY KEY (flow_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_nodes_pkey' AND conrelid = 'public.admin_flow_nodes'::regclass) THEN
    ALTER TABLE public.admin_flow_nodes ADD CONSTRAINT admin_flow_nodes_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_schedule_runs_pkey' AND conrelid = 'public.admin_flow_schedule_runs'::regclass) THEN
    ALTER TABLE public.admin_flow_schedule_runs ADD CONSTRAINT admin_flow_schedule_runs_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flows_pkey' AND conrelid = 'public.admin_flows'::regclass) THEN
    ALTER TABLE public.admin_flows ADD CONSTRAINT admin_flows_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_keyword_replies_pkey' AND conrelid = 'public.admin_keyword_replies'::regclass) THEN
    ALTER TABLE public.admin_keyword_replies ADD CONSTRAINT admin_keyword_replies_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_login_throttle_pkey' AND conrelid = 'public.admin_login_throttle'::regclass) THEN
    ALTER TABLE public.admin_login_throttle ADD CONSTRAINT admin_login_throttle_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_manual_bonus_logs_pkey' AND conrelid = 'public.admin_manual_bonus_logs'::regclass) THEN
    ALTER TABLE public.admin_manual_bonus_logs ADD CONSTRAINT admin_manual_bonus_logs_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_message_templates_pkey' AND conrelid = 'public.admin_message_templates'::regclass) THEN
    ALTER TABLE public.admin_message_templates ADD CONSTRAINT admin_message_templates_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_push_settings_pkey' AND conrelid = 'public.admin_push_settings'::regclass) THEN
    ALTER TABLE public.admin_push_settings ADD CONSTRAINT admin_push_settings_pkey PRIMARY KEY (slug);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_recipient_list_members_pkey' AND conrelid = 'public.admin_recipient_list_members'::regclass) THEN
    ALTER TABLE public.admin_recipient_list_members ADD CONSTRAINT admin_recipient_list_members_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_recipient_lists_pkey' AND conrelid = 'public.admin_recipient_lists'::regclass) THEN
    ALTER TABLE public.admin_recipient_lists ADD CONSTRAINT admin_recipient_lists_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_test_recipients_pkey' AND conrelid = 'public.admin_test_recipients'::regclass) THEN
    ALTER TABLE public.admin_test_recipients ADD CONSTRAINT admin_test_recipients_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'booking_source_answers_pkey' AND conrelid = 'public.booking_source_answers'::regclass) THEN
    ALTER TABLE public.booking_source_answers ADD CONSTRAINT booking_source_answers_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_draw_winners_pkey' AND conrelid = 'public.campaign_draw_winners'::regclass) THEN
    ALTER TABLE public.campaign_draw_winners ADD CONSTRAINT campaign_draw_winners_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_phone_registrations_pkey' AND conrelid = 'public.campaign_phone_registrations'::regclass) THEN
    ALTER TABLE public.campaign_phone_registrations ADD CONSTRAINT campaign_phone_registrations_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_settings_pkey' AND conrelid = 'public.campaign_settings'::regclass) THEN
    ALTER TABLE public.campaign_settings ADD CONSTRAINT campaign_settings_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'coupon_codes_pkey' AND conrelid = 'public.coupon_codes'::regclass) THEN
    ALTER TABLE public.coupon_codes ADD CONSTRAINT coupon_codes_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'draw_logs_pkey' AND conrelid = 'public.draw_logs'::regclass) THEN
    ALTER TABLE public.draw_logs ADD CONSTRAINT draw_logs_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_booking_tokens_pkey' AND conrelid = 'public.gold_pig_booking_tokens'::regclass) THEN
    ALTER TABLE public.gold_pig_booking_tokens ADD CONSTRAINT gold_pig_booking_tokens_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_pkey' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_cancellation_requests_pkey' AND conrelid = 'public.gold_pig_cancellation_requests'::regclass) THEN
    ALTER TABLE public.gold_pig_cancellation_requests ADD CONSTRAINT gold_pig_cancellation_requests_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liff_asset_blobs_pkey' AND conrelid = 'public.liff_asset_blobs'::regclass) THEN
    ALTER TABLE public.liff_asset_blobs ADD CONSTRAINT liff_asset_blobs_pkey PRIMARY KEY (asset_key);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liff_token_probe_pkey' AND conrelid = 'public.liff_token_probe'::regclass) THEN
    ALTER TABLE public.liff_token_probe ADD CONSTRAINT liff_token_probe_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_follow_sources_pkey' AND conrelid = 'public.line_follow_sources'::regclass) THEN
    ALTER TABLE public.line_follow_sources ADD CONSTRAINT line_follow_sources_pkey PRIMARY KEY (line_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_invites_pkey' AND conrelid = 'public.line_invites'::regclass) THEN
    ALTER TABLE public.line_invites ADD CONSTRAINT line_invites_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_push_logs_pkey' AND conrelid = 'public.line_push_logs'::regclass) THEN
    ALTER TABLE public.line_push_logs ADD CONSTRAINT line_push_logs_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_push_media_pkey' AND conrelid = 'public.line_push_media'::regclass) THEN
    ALTER TABLE public.line_push_media ADD CONSTRAINT line_push_media_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_webhook_events_pkey' AND conrelid = 'public.line_webhook_events'::regclass) THEN
    ALTER TABLE public.line_webhook_events ADD CONSTRAINT line_webhook_events_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'oa_contacts_pkey' AND conrelid = 'public.oa_contacts'::regclass) THEN
    ALTER TABLE public.oa_contacts ADD CONSTRAINT oa_contacts_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'prize_change_logs_pkey' AND conrelid = 'public.prize_change_logs'::regclass) THEN
    ALTER TABLE public.prize_change_logs ADD CONSTRAINT prize_change_logs_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'prizes_pkey' AND conrelid = 'public.prizes'::regclass) THEN
    ALTER TABLE public.prizes ADD CONSTRAINT prizes_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_catalog_pkey' AND conrelid = 'public.restaurant_catalog'::regclass) THEN
    ALTER TABLE public.restaurant_catalog ADD CONSTRAINT restaurant_catalog_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_pkey' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rfm_profiles_pkey' AND conrelid = 'public.rfm_profiles'::regclass) THEN
    ALTER TABLE public.rfm_profiles ADD CONSTRAINT rfm_profiles_pkey PRIMARY KEY (rfm_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_events_pkey' AND conrelid = 'public.user_events'::regclass) THEN
    ALTER TABLE public.user_events ADD CONSTRAINT user_events_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_restaurant_clicks_pkey' AND conrelid = 'public.user_restaurant_clicks'::regclass) THEN
    ALTER TABLE public.user_restaurant_clicks ADD CONSTRAINT user_restaurant_clicks_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_pkey' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activities_slug_key' AND conrelid = 'public.activities'::regclass) THEN
    ALTER TABLE public.activities ADD CONSTRAINT activities_slug_key UNIQUE (slug);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_referrals_activity_id_invitee_line_user_id_key' AND conrelid = 'public.activity_referrals'::regclass) THEN
    ALTER TABLE public.activity_referrals ADD CONSTRAINT activity_referrals_activity_id_invitee_line_user_id_key UNIQUE (activity_id, invitee_line_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_user_quotas_activity_id_line_user_id_key' AND conrelid = 'public.activity_user_quotas'::regclass) THEN
    ALTER TABLE public.activity_user_quotas ADD CONSTRAINT activity_user_quotas_activity_id_line_user_id_key UNIQUE (activity_id, line_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_email_unsubscribes_email_key' AND conrelid = 'public.admin_email_unsubscribes'::regclass) THEN
    ALTER TABLE public.admin_email_unsubscribes ADD CONSTRAINT admin_email_unsubscribes_email_key UNIQUE (email);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_nodes_unique_key' AND conrelid = 'public.admin_flow_nodes'::regclass) THEN
    ALTER TABLE public.admin_flow_nodes ADD CONSTRAINT admin_flow_nodes_unique_key UNIQUE (flow_id, node_key);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_schedule_runs_unique' AND conrelid = 'public.admin_flow_schedule_runs'::regclass) THEN
    ALTER TABLE public.admin_flow_schedule_runs ADD CONSTRAINT admin_flow_schedule_runs_unique UNIQUE (flow_id, period_key);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_draw_winners_campaign_key_phone_normalized_key' AND conrelid = 'public.campaign_draw_winners'::regclass) THEN
    ALTER TABLE public.campaign_draw_winners ADD CONSTRAINT campaign_draw_winners_campaign_key_phone_normalized_key UNIQUE (campaign_key, phone_normalized);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_phone_registrations_campaign_key_line_user_id_phon_key' AND conrelid = 'public.campaign_phone_registrations'::regclass) THEN
    ALTER TABLE public.campaign_phone_registrations ADD CONSTRAINT campaign_phone_registrations_campaign_key_line_user_id_phon_key UNIQUE (campaign_key, line_user_id, phone_normalized);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'coupon_codes_activity_code_uniq' AND conrelid = 'public.coupon_codes'::regclass) THEN
    ALTER TABLE public.coupon_codes ADD CONSTRAINT coupon_codes_activity_code_uniq UNIQUE (activity_id, code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_booking_tokens_token_hash_key' AND conrelid = 'public.gold_pig_booking_tokens'::regclass) THEN
    ALTER TABLE public.gold_pig_booking_tokens ADD CONSTRAINT gold_pig_booking_tokens_token_hash_key UNIQUE (token_hash);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_booking_no_key' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_booking_no_key UNIQUE (booking_no);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_invites_invitee_line_user_id_key' AND conrelid = 'public.line_invites'::regclass) THEN
    ALTER TABLE public.line_invites ADD CONSTRAINT line_invites_invitee_line_user_id_key UNIQUE (invitee_line_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'oa_contacts_oa_key_line_user_id_key' AND conrelid = 'public.oa_contacts'::regclass) THEN
    ALTER TABLE public.oa_contacts ADD CONSTRAINT oa_contacts_oa_key_line_user_id_key UNIQUE (oa_key, line_user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_catalog_ref_key_key' AND conrelid = 'public.restaurant_catalog'::regclass) THEN
    ALTER TABLE public.restaurant_catalog ADD CONSTRAINT restaurant_catalog_ref_key_key UNIQUE (ref_key);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_application_code_key' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_application_code_key UNIQUE (application_code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_username_key' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_username_key UNIQUE (username);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_bonus_plays_plays_check' AND conrelid = 'public.activity_bonus_plays'::regclass) THEN
    ALTER TABLE public.activity_bonus_plays ADD CONSTRAINT activity_bonus_plays_plays_check CHECK ((plays > 0));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_recipients_identifier_check' AND conrelid = 'public.admin_broadcast_recipients'::regclass) THEN
    ALTER TABLE public.admin_broadcast_recipients ADD CONSTRAINT admin_broadcast_recipients_identifier_check CHECK (((line_user_id IS NOT NULL) OR (email IS NOT NULL)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcasts_channel_check' AND conrelid = 'public.admin_broadcasts'::regclass) THEN
    ALTER TABLE public.admin_broadcasts ADD CONSTRAINT admin_broadcasts_channel_check CHECK ((channel = ANY (ARRAY['line'::text, 'email'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_enroll_status_check' AND conrelid = 'public.admin_flow_enrollments'::regclass) THEN
    ALTER TABLE public.admin_flow_enrollments ADD CONSTRAINT admin_flow_enroll_status_check CHECK ((status = ANY (ARRAY['active'::text, 'done'::text, 'cancelled'::text, 'failed'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_nodes_type_check' AND conrelid = 'public.admin_flow_nodes'::regclass) THEN
    ALTER TABLE public.admin_flow_nodes ADD CONSTRAINT admin_flow_nodes_type_check CHECK ((type = ANY (ARRAY['send'::text, 'wait'::text, 'branch'::text, 'end'::text, 'add_to_list'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flows_status_check' AND conrelid = 'public.admin_flows'::regclass) THEN
    ALTER TABLE public.admin_flows ADD CONSTRAINT admin_flows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flows_trigger_check' AND conrelid = 'public.admin_flows'::regclass) THEN
    ALTER TABLE public.admin_flows ADD CONSTRAINT admin_flows_trigger_check CHECK ((trigger_type = ANY (ARRAY['follow'::text, 'list_join'::text, 'event'::text, 'schedule'::text, 'game_play'::text, 'broadcast_click'::text, 'restaurant_click'::text, 'inactivity'::text, 'streak_risk'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_message_templates_channel_check' AND conrelid = 'public.admin_message_templates'::regclass) THEN
    ALTER TABLE public.admin_message_templates ADD CONSTRAINT admin_message_templates_channel_check CHECK ((channel = ANY (ARRAY['line'::text, 'email'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_recipient_list_members_identifier_check' AND conrelid = 'public.admin_recipient_list_members'::regclass) THEN
    ALTER TABLE public.admin_recipient_list_members ADD CONSTRAINT admin_recipient_list_members_identifier_check CHECK (((line_user_id IS NOT NULL) OR (email IS NOT NULL)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'campaign_settings_id_check' AND conrelid = 'public.campaign_settings'::regclass) THEN
    ALTER TABLE public.campaign_settings ADD CONSTRAINT campaign_settings_id_check CHECK ((id = 1));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_booking_tokens_token_hash_check' AND conrelid = 'public.gold_pig_booking_tokens'::regclass) THEN
    ALTER TABLE public.gold_pig_booking_tokens ADD CONSTRAINT gold_pig_booking_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_guest_count_check' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_guest_count_check CHECK (((guest_count > 0) AND (guest_count <= 120)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_status_check' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'cancellation_requested'::text, 'cancelled'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_tables_4_check' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_tables_4_check CHECK (((tables_4 >= 0) AND (tables_4 <= 20)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_tables_6_check' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_tables_6_check CHECK (((tables_6 >= 0) AND (tables_6 <= 20)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_bookings_total_amount_check' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_bookings_total_amount_check CHECK ((total_amount > 0));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_tables_present' AND conrelid = 'public.gold_pig_bookings'::regclass) THEN
    ALTER TABLE public.gold_pig_bookings ADD CONSTRAINT gold_pig_tables_present CHECK ((((tables_4 + tables_6) >= 1) AND ((tables_4 + tables_6) <= 2)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_cancellation_requests_status_check' AND conrelid = 'public.gold_pig_cancellation_requests'::regclass) THEN
    ALTER TABLE public.gold_pig_cancellation_requests ADD CONSTRAINT gold_pig_cancellation_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'line_push_media_mime_chk' AND conrelid = 'public.line_push_media'::regclass) THEN
    ALTER TABLE public.line_push_media ADD CONSTRAINT line_push_media_mime_chk CHECK ((mime_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_booking_system_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_booking_system_length CHECK (((current_booking_system IS NULL) OR (char_length(current_booking_system) <= 100)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_contact_name_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_contact_name_length CHECK (((char_length(contact_name) >= 1) AND (char_length(contact_name) <= 80)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_contact_time_check' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_contact_time_check CHECK (((preferred_contact_time = ANY (ARRAY['morning'::text, 'afternoon'::text, 'evening'::text, 'anytime'::text])) OR ((preferred_contact_time ~~ 'custom:%'::text) AND ((char_length(btrim(SUBSTRING(preferred_contact_time FROM 8))) >= 2) AND (char_length(btrim(SUBSTRING(preferred_contact_time FROM 8))) <= 72)) AND (char_length(preferred_contact_time) <= 80))));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_goal_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_goal_length CHECK (((primary_goal IS NULL) OR (char_length(primary_goal) <= 120)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_location_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_location_length CHECK (((char_length(location) >= 2) AND (char_length(location) <= 100)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_notes_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_notes_length CHECK (((internal_notes IS NULL) OR (char_length(internal_notes) <= 5000)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_page_url_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_page_url_length CHECK (((landing_page_url IS NULL) OR (char_length(landing_page_url) <= 500)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_phone_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_phone_length CHECK (((char_length(phone_normalized) >= 8) AND (char_length(phone_normalized) <= 15)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_restaurant_name_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_restaurant_name_length CHECK (((char_length(restaurant_name) >= 1) AND (char_length(restaurant_name) <= 120)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_source_length' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_source_length CHECK (((char_length(source) >= 1) AND (char_length(source) <= 80)));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'restaurant_trial_applications_status_check' AND conrelid = 'public.restaurant_trial_applications'::regclass) THEN
    ALTER TABLE public.restaurant_trial_applications ADD CONSTRAINT restaurant_trial_applications_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'trial_setup'::text, 'trial_active'::text, 'converted'::text, 'closed'::text])));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_admin_role_chk' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_admin_role_chk CHECK (((is_admin = false) OR (role = ANY (ARRAY['admin'::text, 'staff'::text]))));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_role_check' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (((role IS NULL) OR (role = ANY (ARRAY['admin'::text, 'staff'::text]))));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_plays_activity_id_fkey' AND conrelid = 'public.activity_plays'::regclass) THEN
    ALTER TABLE public.activity_plays ADD CONSTRAINT activity_plays_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_plays_prize_id_fkey' AND conrelid = 'public.activity_plays'::regclass) THEN
    ALTER TABLE public.activity_plays ADD CONSTRAINT activity_plays_prize_id_fkey FOREIGN KEY (prize_id) REFERENCES activity_prizes(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_prizes_activity_id_fkey' AND conrelid = 'public.activity_prizes'::regclass) THEN
    ALTER TABLE public.activity_prizes ADD CONSTRAINT activity_prizes_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_referrals_activity_id_fkey' AND conrelid = 'public.activity_referrals'::regclass) THEN
    ALTER TABLE public.activity_referrals ADD CONSTRAINT activity_referrals_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'activity_user_quotas_activity_id_fkey' AND conrelid = 'public.activity_user_quotas'::regclass) THEN
    ALTER TABLE public.activity_user_quotas ADD CONSTRAINT activity_user_quotas_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_clicks_broadcast_id_fkey' AND conrelid = 'public.admin_broadcast_clicks'::regclass) THEN
    ALTER TABLE public.admin_broadcast_clicks ADD CONSTRAINT admin_broadcast_clicks_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES admin_broadcasts(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_recipients_broadcast_id_fkey' AND conrelid = 'public.admin_broadcast_recipients'::regclass) THEN
    ALTER TABLE public.admin_broadcast_recipients ADD CONSTRAINT admin_broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES admin_broadcasts(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_broadcast_views_broadcast_id_fkey' AND conrelid = 'public.admin_broadcast_views'::regclass) THEN
    ALTER TABLE public.admin_broadcast_views ADD CONSTRAINT admin_broadcast_views_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES admin_broadcasts(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_email_unsubscribes_broadcast_id_fkey' AND conrelid = 'public.admin_email_unsubscribes'::regclass) THEN
    ALTER TABLE public.admin_email_unsubscribes ADD CONSTRAINT admin_email_unsubscribes_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES admin_broadcasts(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_clicks_enrollment_id_fkey' AND conrelid = 'public.admin_flow_clicks'::regclass) THEN
    ALTER TABLE public.admin_flow_clicks ADD CONSTRAINT admin_flow_clicks_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES admin_flow_enrollments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_enrollments_flow_id_fkey' AND conrelid = 'public.admin_flow_enrollments'::regclass) THEN
    ALTER TABLE public.admin_flow_enrollments ADD CONSTRAINT admin_flow_enrollments_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES admin_flows(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_event_cursor_flow_id_fkey' AND conrelid = 'public.admin_flow_event_cursor'::regclass) THEN
    ALTER TABLE public.admin_flow_event_cursor ADD CONSTRAINT admin_flow_event_cursor_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES admin_flows(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_nodes_flow_id_fkey' AND conrelid = 'public.admin_flow_nodes'::regclass) THEN
    ALTER TABLE public.admin_flow_nodes ADD CONSTRAINT admin_flow_nodes_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES admin_flows(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_flow_schedule_runs_flow_id_fkey' AND conrelid = 'public.admin_flow_schedule_runs'::regclass) THEN
    ALTER TABLE public.admin_flow_schedule_runs ADD CONSTRAINT admin_flow_schedule_runs_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES admin_flows(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_keyword_replies_message_template_id_fkey' AND conrelid = 'public.admin_keyword_replies'::regclass) THEN
    ALTER TABLE public.admin_keyword_replies ADD CONSTRAINT admin_keyword_replies_message_template_id_fkey FOREIGN KEY (message_template_id) REFERENCES admin_message_templates(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_push_settings_image_media_id_fkey' AND conrelid = 'public.admin_push_settings'::regclass) THEN
    ALTER TABLE public.admin_push_settings ADD CONSTRAINT admin_push_settings_image_media_id_fkey FOREIGN KEY (image_media_id) REFERENCES line_push_media(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_recipient_list_members_list_id_fkey' AND conrelid = 'public.admin_recipient_list_members'::regclass) THEN
    ALTER TABLE public.admin_recipient_list_members ADD CONSTRAINT admin_recipient_list_members_list_id_fkey FOREIGN KEY (list_id) REFERENCES admin_recipient_lists(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_booking_tokens_booking_id_fkey' AND conrelid = 'public.gold_pig_booking_tokens'::regclass) THEN
    ALTER TABLE public.gold_pig_booking_tokens ADD CONSTRAINT gold_pig_booking_tokens_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES gold_pig_bookings(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gold_pig_cancellation_requests_booking_id_fkey' AND conrelid = 'public.gold_pig_cancellation_requests'::regclass) THEN
    ALTER TABLE public.gold_pig_cancellation_requests ADD CONSTRAINT gold_pig_cancellation_requests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES gold_pig_bookings(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_activities_game_type ON public.activities USING btree (game_type);
CREATE INDEX IF NOT EXISTS idx_activities_slug ON public.activities USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_activities_status ON public.activities USING btree (status);
CREATE INDEX IF NOT EXISTS idx_abp_lookup ON public.activity_bonus_plays USING btree (activity_id, line_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_abp_granted_key ON public.activity_bonus_plays USING btree (granted_key) WHERE (granted_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS ap_luid_played_idx ON public.activity_plays USING btree (line_user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_plays_activity_id ON public.activity_plays USING btree (activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_plays_line_user ON public.activity_plays USING btree (line_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_plays_played_at ON public.activity_plays USING btree (played_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_plays_user_played ON public.activity_plays USING btree (activity_id, line_user_id, played_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plays_mgm_key ON public.activity_plays USING btree (((properties ->> 'mgm_key'::text))) WHERE ((properties ->> 'mgm_key'::text) IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_prizes_activity_id ON public.activity_prizes USING btree (activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_prizes_position ON public.activity_prizes USING btree (activity_id, "position");
CREATE INDEX IF NOT EXISTS idx_ara_invitee ON public.activity_referral_attempts USING btree (invitee_line_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ara_inviter ON public.activity_referral_attempts USING btree (inviter_line_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ara_slug ON public.activity_referral_attempts USING btree (activity_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_referrals_invitee ON public.activity_referrals USING btree (invitee_line_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_referrals_inviter ON public.activity_referrals USING btree (activity_id, inviter_line_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_user_quotas_activity_id ON public.activity_user_quotas USING btree (activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_user_quotas_line_user_id ON public.activity_user_quotas USING btree (line_user_id);
CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_broadcast_id_idx ON public.admin_broadcast_clicks USING btree (broadcast_id);
CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_broadcast_user_idx ON public.admin_broadcast_clicks USING btree (broadcast_id, line_user_id);
CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_broadcast_variant_idx ON public.admin_broadcast_clicks USING btree (broadcast_id, variant);
CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_clicked_at_idx ON public.admin_broadcast_clicks USING btree (clicked_at DESC);
CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_line_user_id_idx ON public.admin_broadcast_clicks USING btree (line_user_id) WHERE (line_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_admin_broadcast_clicks_email ON public.admin_broadcast_clicks USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_broadcast_status_idx ON public.admin_broadcast_recipients USING btree (broadcast_id, status);
CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_broadcast_variant_idx ON public.admin_broadcast_recipients USING btree (broadcast_id, variant);
CREATE INDEX IF NOT EXISTS idx_admin_broadcast_recipients_email ON public.admin_broadcast_recipients USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_admin_broadcast_recipients_provider_msg ON public.admin_broadcast_recipients USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_broadcast_views_broadcast_id_idx ON public.admin_broadcast_views USING btree (broadcast_id);
CREATE INDEX IF NOT EXISTS admin_broadcast_views_broadcast_user_idx ON public.admin_broadcast_views USING btree (broadcast_id, line_user_id);
CREATE INDEX IF NOT EXISTS admin_broadcast_views_broadcast_variant_idx ON public.admin_broadcast_views USING btree (broadcast_id, variant);
CREATE INDEX IF NOT EXISTS admin_broadcast_views_line_user_id_idx ON public.admin_broadcast_views USING btree (line_user_id) WHERE (line_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_broadcast_views_viewed_at_idx ON public.admin_broadcast_views USING btree (viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_broadcast_views_email ON public.admin_broadcast_views USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_broadcasts_created_id_desc_idx ON public.admin_broadcasts USING btree (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_broadcasts_status_idx ON public.admin_broadcasts USING btree (status);
CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_channel ON public.admin_broadcasts USING btree (channel);
CREATE INDEX IF NOT EXISTS idx_admin_email_unsubscribes_email ON public.admin_email_unsubscribes USING btree (email);
CREATE INDEX IF NOT EXISTS idx_flow_clicks_enroll ON public.admin_flow_clicks USING btree (enrollment_id, clicked_at);
CREATE UNIQUE INDEX IF NOT EXISTS admin_flow_enrollments_active_unique ON public.admin_flow_enrollments USING btree (flow_id, line_user_id) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS idx_afe_status_nextrun ON public.admin_flow_enrollments USING btree (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_flow_enroll_due ON public.admin_flow_enrollments USING btree (next_run_at) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS idx_flow_enroll_flow_user ON public.admin_flow_enrollments USING btree (flow_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow ON public.admin_flow_nodes USING btree (flow_id);
CREATE INDEX IF NOT EXISTS admin_keyword_replies_active_priority_idx ON public.admin_keyword_replies USING btree (is_active, priority, id);
CREATE INDEX IF NOT EXISTS admin_login_throttle_ip_created_idx ON public.admin_login_throttle USING btree (ip_key, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_manual_bonus_logs_created_id_desc_idx ON public.admin_manual_bonus_logs USING btree (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_message_templates_created_id_desc_idx ON public.admin_message_templates USING btree (created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS admin_message_templates_name_unique ON public.admin_message_templates USING btree (btrim(name));
CREATE UNIQUE INDEX IF NOT EXISTS admin_recipient_list_members_list_id_email_unique ON public.admin_recipient_list_members USING btree (list_id, lower(email)) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_recipient_list_members_list_id_idx ON public.admin_recipient_list_members USING btree (list_id);
CREATE UNIQUE INDEX IF NOT EXISTS admin_recipient_list_members_list_id_line_user_id_unique ON public.admin_recipient_list_members USING btree (list_id, line_user_id) WHERE (line_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_admin_recipient_list_members_email ON public.admin_recipient_list_members USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS admin_recipient_lists_created_id_desc_idx ON public.admin_recipient_lists USING btree (created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS admin_test_recipients_line_user_id_unique ON public.admin_test_recipients USING btree (line_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS bsa_dedup_idx ON public.booking_source_answers USING btree (line_user_id, answered_at, source_key);
CREATE INDEX IF NOT EXISTS bsa_source_idx ON public.booking_source_answers USING btree (source_key);
CREATE INDEX IF NOT EXISTS bsa_user_idx ON public.booking_source_answers USING btree (line_user_id, answered_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdw_campaign ON public.campaign_draw_winners USING btree (campaign_key, drawn_at DESC);
CREATE INDEX IF NOT EXISTS cpr_campaign_phone_idx ON public.campaign_phone_registrations USING btree (campaign_key, phone_normalized);
CREATE INDEX IF NOT EXISTS cpr_campaign_user_idx ON public.campaign_phone_registrations USING btree (campaign_key, line_user_id);
CREATE INDEX IF NOT EXISTS coupon_codes_pick_idx ON public.coupon_codes USING btree (activity_id, prize_id, status);
CREATE INDEX IF NOT EXISTS draw_logs_user_id_id_desc_idx ON public.draw_logs USING btree (user_id, id DESC);
CREATE INDEX IF NOT EXISTS gold_pig_booking_tokens_active_idx ON public.gold_pig_booking_tokens USING btree (expires_at, booking_id) WHERE (used_at IS NULL);
CREATE INDEX IF NOT EXISTS gold_pig_booking_tokens_booking_idx ON public.gold_pig_booking_tokens USING btree (booking_id);
CREATE INDEX IF NOT EXISTS gold_pig_bookings_line_status_idx ON public.gold_pig_bookings USING btree (line_user_id, status, session_date) WHERE (line_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS gold_pig_bookings_session_idx ON public.gold_pig_bookings USING btree (session_date, session_time, status);
CREATE INDEX IF NOT EXISTS gold_pig_cancel_booking_idx ON public.gold_pig_cancellation_requests USING btree (booking_id);
CREATE INDEX IF NOT EXISTS gold_pig_cancel_line_created_idx ON public.gold_pig_cancellation_requests USING btree (line_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS gold_pig_cancel_one_pending_idx ON public.gold_pig_cancellation_requests USING btree (booking_id) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_liff_probe_created ON public.liff_token_probe USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS line_follow_sources_source_idx ON public.line_follow_sources USING btree (source_key);
CREATE INDEX IF NOT EXISTS line_invites_inviter_user_id_idx ON public.line_invites USING btree (inviter_user_id);
CREATE INDEX IF NOT EXISTS line_push_logs_created_id_desc_idx ON public.line_push_logs USING btree (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS line_push_logs_status_idx ON public.line_push_logs USING btree (status);
CREATE INDEX IF NOT EXISTS line_push_logs_user_id_idx ON public.line_push_logs USING btree (user_id);
CREATE INDEX IF NOT EXISTS line_webhook_events_created_id_desc_idx ON public.line_webhook_events USING btree (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS line_webhook_events_line_user_id_idx ON public.line_webhook_events USING btree (line_user_id);
CREATE INDEX IF NOT EXISTS lwe_luid_ts_idx ON public.line_webhook_events USING btree (line_user_id, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS oa_contacts_last_event_idx ON public.oa_contacts USING btree (oa_key, last_event_at DESC);
CREATE INDEX IF NOT EXISTS oa_contacts_oa_key_idx ON public.oa_contacts USING btree (oa_key);
CREATE INDEX IF NOT EXISTS prizes_quantity_id_idx ON public.prizes USING btree (quantity, id);
CREATE INDEX IF NOT EXISTS restaurant_trial_applications_phone_created_idx ON public.restaurant_trial_applications USING btree (phone_normalized, created_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_trial_applications_status_created_idx ON public.restaurant_trial_applications USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfm_email ON public.rfm_profiles USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));
CREATE INDEX IF NOT EXISTS idx_rfm_line ON public.rfm_profiles USING btree (line_user_id) WHERE (line_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rfm_phone ON public.rfm_profiles USING btree (phone) WHERE ((phone IS NOT NULL) AND (phone <> ''::text));
CREATE INDEX IF NOT EXISTS idx_rfm_recency ON public.rfm_profiles USING btree (recency);
CREATE INDEX IF NOT EXISTS idx_user_events_created_at ON public.user_events USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_event_created ON public.user_events USING btree (event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_event_name ON public.user_events USING btree (event_name);
CREATE INDEX IF NOT EXISTS idx_user_events_line_id ON public.user_events USING btree (line_id);
CREATE INDEX IF NOT EXISTS idx_user_events_session_id ON public.user_events USING btree (session_id);
CREATE INDEX IF NOT EXISTS user_events_line_created_idx ON public.user_events USING btree (line_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_events_line_id_idx ON public.user_events USING btree (line_id);
CREATE INDEX IF NOT EXISTS idx_urc_cuisine ON public.user_restaurant_clicks USING btree (cuisine) WHERE (cuisine IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_urc_query ON public.user_restaurant_clicks USING btree (lower(restaurant_query));
CREATE INDEX IF NOT EXISTS idx_urc_user ON public.user_restaurant_clicks USING btree (line_user_id, clicked_at);
CREATE INDEX IF NOT EXISTS urc_refkey_idx ON public.user_restaurant_clicks USING btree (COALESCE(poi_id, lower(btrim(restaurant_query))));
CREATE INDEX IF NOT EXISTS idx_users_blocked ON public.users USING btree (blocked_at) WHERE (blocked_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS users_archived_at_idx ON public.users USING btree (archived_at) WHERE (archived_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code_unique_idx ON public.users USING btree (invite_code);
CREATE INDEX IF NOT EXISTS users_line_id_hash_idx ON public.users USING btree (line_id_hash);
CREATE UNIQUE INDEX IF NOT EXISTS users_line_user_id_unique_idx ON public.users USING btree (line_user_id);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- 注意：只有下列 28 張表開了 RLS。另外 23 張沒開（見檔案開頭說明）。
ALTER TABLE public.admin_broadcast_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcast_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_keyword_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_login_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_manual_bonus_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_push_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_recipient_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_recipient_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_test_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draw_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_pig_booking_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_pig_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_pig_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liff_asset_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_push_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_push_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prize_change_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_trial_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- ── Policies ───────────────────────────────────────────────────────────────
-- 應用程式以 DATABASE_URL（postgres / service_role）連線，policy 只放行這兩個角色；
-- anon / authenticated 沒有 policy = 讀不到（PostgREST 裸奔防線）。
DO $$
DECLARE t text;
BEGIN
  -- service_role 是 Supabase 才有的角色。一般 Postgres（本機開發）沒有這個角色，
  -- CREATE POLICY ... TO service_role 會直接報錯，所以整段跳過；
  -- 本機用 superuser 連線本來就繞過 RLS，不影響開發。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE '跳過 policy：這個資料庫沒有 service_role 角色（非 Supabase）';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'admin_broadcast_clicks','admin_broadcast_recipients','admin_broadcast_views',
    'admin_broadcasts','admin_keyword_replies','admin_login_throttle',
    'admin_manual_bonus_logs','admin_message_templates','admin_push_settings',
    'admin_recipient_list_members','admin_recipient_lists','admin_test_recipients',
    'campaign_settings','coupon_codes','draw_logs','line_invites','line_push_logs',
    'line_push_media','line_webhook_events','prize_change_logs','prizes',
    'restaurant_catalog','users'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_server_full_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY app_server_full_access ON public.%I AS PERMISSIVE FOR ALL '
      'TO postgres, service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN RETURN; END IF;

  DROP POLICY IF EXISTS gold_pig_tokens_service_all ON public.gold_pig_booking_tokens;
  CREATE POLICY gold_pig_tokens_service_all ON public.gold_pig_booking_tokens
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

  DROP POLICY IF EXISTS gold_pig_bookings_service_all ON public.gold_pig_bookings;
  CREATE POLICY gold_pig_bookings_service_all ON public.gold_pig_bookings
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

  DROP POLICY IF EXISTS gold_pig_cancellations_service_all ON public.gold_pig_cancellation_requests;
  CREATE POLICY gold_pig_cancellations_service_all ON public.gold_pig_cancellation_requests
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

-- ── Functions ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_restaurant_trial_application_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- ── Triggers ───────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS activities_set_updated_at ON public.activities;
CREATE TRIGGER activities_set_updated_at BEFORE UPDATE ON public.activities
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS activity_user_quotas_set_updated_at ON public.activity_user_quotas;
CREATE TRIGGER activity_user_quotas_set_updated_at BEFORE UPDATE ON public.activity_user_quotas
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS restaurant_trial_applications_set_updated_at ON public.restaurant_trial_applications;
CREATE TRIGGER restaurant_trial_applications_set_updated_at BEFORE UPDATE ON public.restaurant_trial_applications
  FOR EACH ROW EXECUTE FUNCTION set_restaurant_trial_application_updated_at();

-- ── Views ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.member_booking_source AS
 SELECT DISTINCT ON (line_user_id) line_user_id,
    source_key,
    source_label,
    raw_text,
    answered_at
   FROM booking_source_answers
  ORDER BY line_user_id, answered_at DESC;

CREATE OR REPLACE VIEW public.member_liff_events AS
 SELECT u.id AS user_id,
    u.line_user_id,
    ue.id AS event_id,
    ue.event_name,
    ue.properties,
    ue.session_id,
    ue.created_at
   FROM (user_events ue
     JOIN users u ON (((ue.line_id = u.line_user_id) OR (ue.line_id = u.line_id_hash))))
  WHERE (ue.line_id IS NOT NULL);

-- ── Comments ───────────────────────────────────────────────────────────────
COMMENT ON TABLE public.booking_source_answers IS '使用者回答「您是透過哪裡預訂的？」的紀錄；來源由 webhook 解析「透過 X 訂位/預訂」句型';
COMMENT ON TABLE public.campaign_phone_registrations IS '活動資格登記：使用者在 LINE OA 輸入訂位手機，用來把 LINE 身分綁到訂位紀錄';
COMMENT ON TABLE public.gold_pig_booking_tokens IS '訂位 LINE 綁定的一次性 token 雜湊；不可保存原始 token。';
COMMENT ON TABLE public.gold_pig_bookings IS 'Asia Miles 金豬食堂活動訂位；由受信任付款後端建立。';
COMMENT ON TABLE public.gold_pig_cancellation_requests IS '由 LINE Bot 建立的取消申請；pending 不等於已取消或已退款。';
COMMENT ON TABLE public.restaurant_trial_applications IS 'OpenRice 餐廳線上訂位 30 天免費試用 Landing Page 申請名單。';

COMMENT ON COLUMN public.activities.base_plays_per_user IS '每用戶基礎可玩次數';
COMMENT ON COLUMN public.activities.liff_id_override IS 'NULL = 用 GAMES_LIFF_ID 環境變數；填值 = 用此活動專屬的 LIFF App（譬如 Aggressive 加好友的拉新活動）';
COMMENT ON COLUMN public.activities.referral_bonus_max IS '透過邀請最多可加幾次（cap）';
COMMENT ON COLUMN public.activities.referral_bonus_per IS '每邀請成功 1 人加幾次（0=關閉 MGM）';
COMMENT ON COLUMN public.activity_referrals.invitee_was_existing IS 'true=邀請當下對方已是既有會員（非新獲客）；false=新加入；NULL=舊資料無從判斷';
COMMENT ON COLUMN public.rfm_profiles.monetary_est IS '預估價位帶（餐廳客單價推算），非真實消費金額';
COMMENT ON COLUMN public.users.archived_at IS '非 NULL = 屬於已停用的舊 OA，無法推播，排除於群發受眾之外';

COMMENT ON VIEW public.member_liff_events IS 'LIFF 行為事件對應到 CRM 會員；涵蓋明碼與 sha256 兩種 line_id 型態';

-- ── Supabase 專屬（只有在 auth schema 存在時才建）─────────────────────────
-- restaurant_trial_applications 的後台讀取權限靠 Supabase Auth 判斷管理員。
-- 一般 Postgres（本機開發）沒有 auth schema，整段跳過。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'auth' AND table_name = 'users') THEN
    CREATE SCHEMA IF NOT EXISTS restaurant_trial_private;
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION restaurant_trial_private.is_authorized_admin()
       RETURNS boolean
       LANGUAGE sql
       STABLE SECURITY DEFINER
       SET search_path TO ''
      AS $body$
        select exists (
          select 1
          from auth.users as users
          where users.id = (select auth.uid())
            and users.raw_app_meta_data @> '{"restaurant_trial_admin": true}'::jsonb
            and (users.banned_until is null or users.banned_until < now())
        );
      $body$;
    $fn$;
    DROP POLICY IF EXISTS "Authorized staff can read restaurant trial applications"
      ON public.restaurant_trial_applications;
    CREATE POLICY "Authorized staff can read restaurant trial applications"
      ON public.restaurant_trial_applications
      AS PERMISSIVE FOR SELECT TO authenticated
      USING ((SELECT restaurant_trial_private.is_authorized_admin()));
  END IF;
END $$;
