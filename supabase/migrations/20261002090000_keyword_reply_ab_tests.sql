-- 關鍵字回覆 A/B 測試
-- 只新增資料表，不修改任何既有資料表或資料。
-- 不寫死 schema 名稱：在 Staging 以 search_path = crm_staging 套用，正式站以 public 套用。
--
-- 影響評估
--   * 新表 4 張，皆為空表，套用時不鎖既有表、不回填資料。
--   * 既有關鍵字規則在沒有建立實驗前，行為完全不變。
--   * admin_keyword_replies 被刪除時，實驗保留（rule_id 設為 NULL），數據不消失。
-- 回滾：supabase/rollbacks/20261002090000_keyword_reply_ab_tests_rollback.sql

-- 1) 實驗本身。A／B 內容在建立時就鎖成快照，之後改訊息庫不影響進行中的實驗。
CREATE TABLE IF NOT EXISTS keyword_reply_experiments (
  id                    bigserial PRIMARY KEY,
  rule_id               integer REFERENCES admin_keyword_replies(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'running',
  variant_a_template_id bigint,
  variant_b_template_id bigint,
  variant_a_name        text,
  variant_b_name        text,
  variant_a_config      jsonb NOT NULL,
  variant_b_config      jsonb NOT NULL,
  targets               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 各版可追蹤的連結清單（快照）與主要目標
  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  fallback_variant      text NOT NULL DEFAULT 'a',
  attribution_days      integer NOT NULL DEFAULT 7,
  change_log            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  CONSTRAINT keyword_reply_experiments_status_check CHECK (status IN ('running', 'paused', 'ended')),
  CONSTRAINT keyword_reply_experiments_fallback_check CHECK (fallback_variant IN ('a', 'b')),
  CONSTRAINT keyword_reply_experiments_window_check CHECK (end_at > start_at),
  CONSTRAINT keyword_reply_experiments_attribution_check CHECK (attribution_days BETWEEN 1 AND 60)
);
-- 同一條規則同時只能有一個未結束的實驗
CREATE UNIQUE INDEX IF NOT EXISTS keyword_reply_experiments_one_open_per_rule
  ON keyword_reply_experiments (rule_id) WHERE status IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS keyword_reply_experiments_rule_idx
  ON keyword_reply_experiments (rule_id, id DESC);

-- 2) 分組：同一實驗、同一人只有一列（主鍵保證並行也不會重複分組）
CREATE TABLE IF NOT EXISTS keyword_reply_experiment_assignments (
  experiment_id    bigint NOT NULL REFERENCES keyword_reply_experiments(id) ON DELETE CASCADE,
  line_user_id     text NOT NULL,
  variant          text NOT NULL,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  first_success_at timestamptz,          -- 第一次 LINE 回覆成功的時間＝點擊觀察期起點
  PRIMARY KEY (experiment_id, line_user_id),
  CONSTRAINT keyword_reply_experiment_assignments_variant_check CHECK (variant IN ('a', 'b'))
);
CREATE INDEX IF NOT EXISTS keyword_reply_experiment_assignments_variant_idx
  ON keyword_reply_experiment_assignments (experiment_id, variant);

-- 3) 每一次觸發的回覆紀錄。webhook_event_id 唯一：LINE 重送同一事件不會再回一次、也不膨脹統計。
--    delivery_code 是放在追蹤連結裡的隨機代碼，連結不含 LINE User ID。
CREATE TABLE IF NOT EXISTS keyword_reply_experiment_deliveries (
  id               bigserial PRIMARY KEY,
  experiment_id    bigint NOT NULL REFERENCES keyword_reply_experiments(id) ON DELETE CASCADE,
  line_user_id     text NOT NULL,
  variant          text NOT NULL,
  webhook_event_id text,
  delivery_code    text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  http_status      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT keyword_reply_experiment_deliveries_variant_check CHECK (variant IN ('a', 'b')),
  CONSTRAINT keyword_reply_experiment_deliveries_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'uncertain'))
);
CREATE UNIQUE INDEX IF NOT EXISTS keyword_reply_experiment_deliveries_event_uniq
  ON keyword_reply_experiment_deliveries (webhook_event_id) WHERE webhook_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS keyword_reply_experiment_deliveries_code_uniq
  ON keyword_reply_experiment_deliveries (delivery_code);
CREATE INDEX IF NOT EXISTS keyword_reply_experiment_deliveries_exp_idx
  ON keyword_reply_experiment_deliveries (experiment_id, variant, status);

-- 4) 點擊：只記「經 LINE 驗證、點擊者就是該次收件人」的點擊
CREATE TABLE IF NOT EXISTS keyword_reply_experiment_clicks (
  id            bigserial PRIMARY KEY,
  delivery_id   bigint NOT NULL REFERENCES keyword_reply_experiment_deliveries(id) ON DELETE CASCADE,
  experiment_id bigint NOT NULL REFERENCES keyword_reply_experiments(id) ON DELETE CASCADE,
  variant       text NOT NULL,
  line_user_id  text NOT NULL,
  target_index  integer NOT NULL,
  clicked_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_reply_experiment_clicks_variant_check CHECK (variant IN ('a', 'b'))
);
CREATE INDEX IF NOT EXISTS keyword_reply_experiment_clicks_exp_idx
  ON keyword_reply_experiment_clicks (experiment_id, variant, line_user_id);

-- 權限：與既有後端資料表一致，只給後端 service_role，前台匿名角色完全不可讀寫
ALTER TABLE keyword_reply_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_reply_experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_reply_experiment_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_reply_experiment_clicks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE keyword_reply_experiments, keyword_reply_experiment_assignments,
             keyword_reply_experiment_deliveries, keyword_reply_experiment_clicks FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE keyword_reply_experiments, keyword_reply_experiment_assignments,
             keyword_reply_experiment_deliveries, keyword_reply_experiment_clicks FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON TABLE keyword_reply_experiments, keyword_reply_experiment_assignments,
             keyword_reply_experiment_deliveries, keyword_reply_experiment_clicks TO service_role';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE keyword_reply_experiments_id_seq,
             keyword_reply_experiment_deliveries_id_seq, keyword_reply_experiment_clicks_id_seq TO service_role';
    EXECUTE 'DROP POLICY IF EXISTS keyword_reply_experiments_service_all ON keyword_reply_experiments';
    EXECUTE 'CREATE POLICY keyword_reply_experiments_service_all ON keyword_reply_experiments FOR ALL TO service_role USING (true) WITH CHECK (true)';
    EXECUTE 'DROP POLICY IF EXISTS keyword_reply_experiment_assignments_service_all ON keyword_reply_experiment_assignments';
    EXECUTE 'CREATE POLICY keyword_reply_experiment_assignments_service_all ON keyword_reply_experiment_assignments FOR ALL TO service_role USING (true) WITH CHECK (true)';
    EXECUTE 'DROP POLICY IF EXISTS keyword_reply_experiment_deliveries_service_all ON keyword_reply_experiment_deliveries';
    EXECUTE 'CREATE POLICY keyword_reply_experiment_deliveries_service_all ON keyword_reply_experiment_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true)';
    EXECUTE 'DROP POLICY IF EXISTS keyword_reply_experiment_clicks_service_all ON keyword_reply_experiment_clicks';
    EXECUTE 'CREATE POLICY keyword_reply_experiment_clicks_service_all ON keyword_reply_experiment_clicks FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMENT ON TABLE keyword_reply_experiments IS '關鍵字回覆 A/B 測試；A／B 內容於建立時鎖定快照。';
COMMENT ON TABLE keyword_reply_experiment_assignments IS '每人在實驗中的固定版本；first_success_at 為點擊觀察期起點。';
COMMENT ON TABLE keyword_reply_experiment_deliveries IS '每次觸發的 LINE 回覆結果；webhook_event_id 防重送，delivery_code 供追蹤連結使用（不含 LINE User ID）。';
COMMENT ON TABLE keyword_reply_experiment_clicks IS '經 LINE 身分驗證、點擊者即收件人的點擊紀錄。';
