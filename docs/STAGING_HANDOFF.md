# CRM 固定 Staging 與同事直接更新流程

## 目標

- `main` 與正式網址只由 Hen 核准後更新。
- 同事與 AI 可直接 push `staging`，固定測試站會自動更新，不需 Hen 核准或每次開 Pull Request。
- Staging 只連 `crm_staging`，不能讀寫正式 `public` 資料。
- Staging 不放正式 LINE、Email、訂位與排程金鑰，因此不會誤發訊息或建立正式訂位。

目前 Supabase 免費方案無法再建立第三個專案，因此 Staging 採「同一個 Supabase 專案、獨立 schema 與獨立最低權限帳號」：正式資料位於 `public`，測試資料位於 `crm_staging`。`crm_staging_app` 已固定 search path，且權限測試確認不能讀取 `public.users`。

## 固定測試站

- 網址：<https://staging--openrice-line-crm.netlify.app>
- 後台：<https://staging--openrice-line-crm.netlify.app/a9k2m4-admin-portal-x7>
- 帳號：`staging-admin`
- 密碼：向 Hen 取得；不得寫進 repo、文件或交給 AI。

## 同事每天怎麼用

1. 直接用白話告訴 AI 要改什麼，並要求只操作 `staging`。
2. AI 先執行 `git fetch origin`、`git switch staging`、`git pull --ff-only origin staging`。
3. AI 完成修改、完整測試與 `git diff --check`。
4. AI commit 後執行 `git pull --rebase origin staging`，確認沒有蓋掉別人的修改，再正常 `git push origin staging`。
5. 等 Netlify 完成後，直接打開上方同一個固定網址 Review；之後每次修改都看這個網址。
6. 若不滿意，繼續告訴 AI 要調整什麼；更新測試站不需 Hen 核准。
7. 確定要上正式站時，才請 AI 建立 `staging -> main` Pull Request，交由 Hen 核准。

## AI 不可違反的安全規則

- 不可把任何正式 `DATABASE_URL`、LINE token、Email API key、公司信箱密碼寫入程式、PR、Issue 或聊天。
- 不可把 Staging 改回正式資料庫，也不可在 Staging 新增任何真實對外發送金鑰。
- 不可直接 push `main`、繞過 branch protection、關閉測試或刪除正式資料。
- 不可 force-push 或刪除 `staging`；推送被拒絕時要先同步及解衝突，不能強蓋。
- 測試資料只能使用明顯標示 `STAGING` 的虛構 LINE ID、Email、餐廳與獎項。
- 測試站若沒有黃色 `STAGING 測試環境` 橫幅，立刻停止測試並通知 Hen。

## 維護者設定

- 建表模板：`scripts/staging/bootstrap-staging.sql`
- Staging branch deploy 必要環境變數：
  - `APP_ENV=staging`
  - `SAFE_PREVIEW_MODE=1`
  - `DATABASE_URL`：只可使用 `crm_staging_app`，search path 由該角色固定為 `crm_staging, extensions`
    - 連線字串不要加 `sslmode=require`；應用程式已自行啟用 TLS，重複設定會讓 Node.js 誤判 Supabase 憑證鏈。
  - `ADMIN_USERNAME=staging-admin`
  - `ADMIN_PASSWORD`、`JWT_SECRET`：Staging 專用，不與正式共用
  - `LIFF_TOKEN_ENFORCE=0`
  - `GOLD_PIG_DEMO_MODE=1`
  - `RUN_DB_DDL_ON_BOOT=0`
- Staging branch deploy 必須沒有：
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
- 完整權限稽核必須確認 `crm_staging_app` 可存取的 `public` relations 為 0，且 `crm_staging` 內指向 `public` 的 View／外鍵均為 0。
