# CRM Staging 與同事 Review 流程

## 目標

- `main` 與正式網址只由 Hen 核准後更新。
- 同事可直接推分支、開 Pull Request，並在 Netlify Deploy Preview 看到修改結果。
- Preview 只連 `crm_staging`，不能讀寫正式 `public` 資料。
- Preview 不放正式 LINE、Email、訂位與排程金鑰，因此不會誤發訊息或建立正式訂位。

目前 Supabase 免費方案無法再建立第三個專案，因此 Staging 採「同一個 Supabase 專案、獨立 schema 與獨立最低權限帳號」：正式資料位於 `public`，測試資料位於 `crm_staging`。`crm_staging_app` 已固定 search path，且權限測試確認不能讀取 `public.users`。

## 同事每天怎麼用

1. 從最新 `main` 建立新分支（建議 `twopenrice-ops/功能名稱`）。
2. 讓 AI 只在該分支修改、測試並推送。
3. 在 GitHub 開 Pull Request；等待 `test` 與 Netlify Deploy Preview 綠燈。
4. 點 PR 內的 Deploy Preview，登入 `staging-admin` 後自行操作與 Review。
5. 覺得完成後請 Hen Review；只有 Hen 核准才可合併到 `main`。

## AI 不可違反的安全規則

- 不可把任何正式 `DATABASE_URL`、LINE token、Email API key、公司信箱密碼寫入程式、PR、Issue 或聊天。
- 不可把 Preview 改回正式資料庫，也不可在 Preview 新增任何真實對外發送金鑰。
- 不可直接 push `main`、繞過 branch protection、關閉測試或刪除正式資料。
- 測試資料只能使用明顯標示 `STAGING` 的虛構 LINE ID、Email、餐廳與獎項。
- PR 畫面若沒有黃色 `STAGING 測試環境` 橫幅，立刻停止測試並通知 Hen。

## 維護者設定

- 建表模板：`scripts/staging/bootstrap-staging.sql`
- Preview 必要環境變數：
  - `APP_ENV=staging`
  - `SAFE_PREVIEW_MODE=1`
  - `DATABASE_URL`：只可使用 `crm_staging_app`，search path 由該角色固定為 `crm_staging, extensions`
    - 連線字串不要加 `sslmode=require`；應用程式已自行啟用 TLS，重複設定會讓 Node.js 誤判 Supabase 憑證鏈。
  - `ADMIN_USERNAME=staging-admin`
  - `ADMIN_PASSWORD`、`JWT_SECRET`：Staging 專用，不與正式共用
  - `LIFF_TOKEN_ENFORCE=0`
  - `GOLD_PIG_DEMO_MODE=1`
  - `RUN_DB_DDL_ON_BOOT=0`
- Preview 必須沒有：
  - `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`
  - `BREVO_API_KEY`、`SURENOTIFY_API_KEY`
  - `GOLD_PIG_BOOKING_API_KEY`
  - `SCHEDULED_RUNNER_SECRET`

## 驗收

- `/healthz` 顯示 `safePreviewMode: true` 與 `appEnv: staging`。
- `/healthz/db` 回傳 `ok: true`。
- 後台每頁上方顯示黃色 STAGING 橫幅。
- 能新增、修改、刪除測試資料；重新整理後仍存在。
- LINE／Email／訂位測試動作只會顯示未設定或跳過，不會送到真人。
- SQL 權限檢查：`crm_staging_app` 對 `public.users` 無 SELECT，對 `crm_staging.users` 有 CRUD。
