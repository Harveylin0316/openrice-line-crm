# 資料庫 schema 怎麼管

## 現況（2026-08-18）

**過去的 DDL 沒有進版控。** 歷來改 schema 都是直接對 Supabase 下語句
（dashboard SQL Editor 或 MCP `apply_migration`），SQL 沒有留在 repo 裡。

對照一下就很清楚：

| 來源 | 數量 |
|---|---|
| Supabase `supabase_migrations.schema_migrations` | **48 筆** |
| 本 repo `supabase/migrations/` | **2 個檔案** |

造成的實際問題：拿這個 repo 從零開一套環境**會整片 500**。
`src/core/dbInit.js` 只建得出 24 張舊表，以下全部沒有：

- `activities`、`activity_prizes`、`activity_plays`、`activity_referrals`
- `activity_user_quotas`、`activity_bonus_plays`、`activity_referral_attempts`
- `coupon_codes`、`user_events`、`rfm_profiles`、`oa_contacts`、`admin_flow_*`
- `booking_source_answers`、`campaign_phone_registrations`、`campaign_draw_winners`…

`users` 也缺 `archived_at`、`created_at`、`blocked_at`、`role`、`is_active`、
`sess_epoch`、`line_id_hash` —— 光 `archived_at` 就有 8 支檔案、24 處在用。

## `schema.sql` 是什麼

線上 public schema 的**完整快照**，從 Supabase catalog 產生，內容經過逐項比對：

| 項目 | 數量 | 與線上 md5 |
|---|---|---|
| 表 | 51 | — |
| 欄位 | 453 | ✅ 一致 |
| 約束（PK/UNIQUE/CHECK/FK） | 118 | ✅ 一致 |
| 索引 | 173 | ✅ 一致 |
| 開了 RLS 的表 | 28 | ✅ 一致 |
| Trigger | 3 | ✅ 一致 |
| View | 2 | ✅ 一致 |
| 註解 | 14 | ✅ 一致 |

### 用法

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

所有語句都可重複執行（`IF NOT EXISTS` / 先 `DROP` 再建），跑第二次是 no-op。
不需要 Supabase —— 一般 Postgres 也可以，`service_role` 角色不存在時
policy 段落會自動跳過（本機用 superuser 連線本來就繞過 RLS）。

### 它不是 migration

只會「補上不存在的東西」，**不會改既有表的欄位**。對已經有舊版表的資料庫執行，
不會幫你把缺的欄位加上去。它的用途是：從零建一套、以及讓 repo 說得出 schema 長怎樣。

## 之後要改 schema 請這樣做

1. 在 `supabase/migrations/` 新增一個 `<timestamp>_描述.sql`
2. 用 `supabase db push` 套用（或在 dashboard 執行後，**把同一份 SQL 補進 repo**）
3. 改完後更新 `supabase/schema.sql` 快照

重點是 SQL 要進版控。直接對 Supabase 下語句、repo 沒有紀錄，就是現在這個狀況的成因。

## ⚠ 未處理：23 張表沒有開 RLS

Supabase advisor 列為 **critical**。這些表對 anon / authenticated 角色完全開放，
拿得到 anon key 的人可以讀寫每一列：

```
user_events                    activity_referrals             admin_flow_schedule_runs
activities                     activity_user_quotas           admin_flow_clicks
activity_prizes                admin_email_unsubscribes       user_restaurant_clicks
activity_plays                 admin_flows                    rfm_profiles
activity_bonus_plays           admin_flow_nodes               liff_token_probe
activity_referral_attempts     admin_flow_enrollments         oa_contacts
booking_source_answers         admin_flow_event_cursor        line_follow_sources
campaign_phone_registrations   campaign_draw_winners
```

`rfm_profiles` 有 51,883 列、`user_events` 3,842 列、`booking_source_answers` 1,401 列。

**降低風險的因素**：本 repo 的前端不使用 supabase-js，也沒有任何地方會發出 anon key
（應用程式一律走伺服器端 `DATABASE_URL`）。所以要利用這個洞，得先另外拿到 anon key。
但舊的 28 張表當初就是為了「防 PostREST 裸奔」才開 RLS，新表沒跟上，等於防線有缺口。

**沒有自動修的原因**：開了 RLS 但沒寫 policy 會把應用程式直接擋死。
正確做法是比照既有表補一條 `app_server_full_access`（只放行 `postgres` / `service_role`）：

```sql
-- 每張表都要「開 RLS」＋「補 policy」，只做前者會讓應用程式讀不到資料
ALTER TABLE public.activity_plays ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_server_full_access ON public.activity_plays
  AS PERMISSIVE FOR ALL TO postgres, service_role USING (true) WITH CHECK (true);
```

這件事要在低流量時段做，並且做完立刻驗證後台與遊戲頁還讀得到資料。

## 既有的兩個 migration

`20260810190000_gold_pig_booking_line.sql` 與 `20260810191500_gold_pig_fk_indexes.sql`
是唯二有進版控的。線上對應的版本號是 `20260810100058` / `20260810100129`
（檔名時間戳與線上紀錄不一致，因為當時是分開手動套用的）。
