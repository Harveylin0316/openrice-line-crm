# OpenRice LINE CRM — AI 接手規則

開始任何工作前，先讀 `docs/AI_HANDOFF.md`，再讀這次任務涉及的 route、core、view 與測試。不要只依賴舊的 `PROJECT_HANDOFF.md`；該檔描述的是早期春日刮刮樂，不是目前完整 CRM。

## Source of truth

1. 目前任務的使用者指示。
2. `origin/main` 的實際程式與測試。
3. 正式 PostgreSQL／Supabase schema 與活動資料。
4. `docs/AI_HANDOFF.md` 的說明。
5. 舊交接文件與程式註解只作輔助；若與程式不一致，以已驗證的現場為準並更新文件。

## 開工前

- 確認 repo root：`git rev-parse --show-toplevel`。
- 執行 `git fetch origin`，檢查 `main...origin/main` 左右差異。
- 檢查工作樹；不得覆蓋其他人或其他 AI 未提交的修改。
- 從最新 `origin/main` 建立 `codex/` 前綴分支。
- 涉及正式資料前，先做唯讀查詢確認活動 ID、slug、狀態與欄位。

## 不可破壞的核心邊界

- 通用遊戲配額只有 `src/core/gamePlayEngine.js` 的 `computeUserQuota()`／`computeQuotaNumbers()` 可以計算。顯示與實際判定必須共用。
- 抽獎必須保留 `play_key` 冪等、交易、獎品列鎖、併發後複查、庫存與 coupon code 同交易領取。
- 前端顯示的輪盤停格必須與伺服器回傳獎品一致；改角度時必跑 7 獎項連轉對齊測試。
- 邀請只把 `invitee_was_existing IS FALSE` 算入加碼；既有好友可以完成自己的首次遊戲，但不能替邀請人增加次數。`invitee_was_existing` 必須以邀請旅程開始前的狀態判斷，不能在 follow webhook 建立會員後才只查 `users`。
- LIFF 身分以 LINE 驗證後的 token `sub` 為準，不可信任前端送來的 `line_user_id`。
- 主 LINE Webhook 與第二 OA Webhook 必須保留 raw body 驗簽，且掛在 JSON body parser 之前。
- Serverless 中需要完成的 DB 寫入與推播必須在回應前 `await`。
- 管理後台 `staff` 與 `admin` 權限不同；帳號、破壞性活動操作、MGM 抽獎等 owner-only 邊界不可放寬。
- 後台資料庫連線失敗時，讀取可降級；寫入必須擋下，不能假裝成功。
- `activities.rules` 更新要合併既有內容；不得用只含新欄位的物件覆蓋整包 JSON。
- 安全預覽 `preview=1` 不得呼叫抽獎、配額、錢包、邀請或其他正式寫入 API。

## 資料庫

- 正式環境用 `pg` 直連 Supabase PostgreSQL；不要擅自改成前端 `supabase-js`。
- `src/core/dbInit.js` 不是完整正式 schema。repo 目前只追蹤部分 migration；新環境建置前要先從 Supabase migration history／正式 schema 補齊。
- Production 應維持 `RUN_DB_DDL_ON_BOOT` 未設定。只有明確在全新本機環境初始化 legacy tables 時才設為 `1`。
- 新增／修改 schema 要建立 migration、驗證索引與 RLS，不能只在 runtime `ALTER TABLE`。
- 不得把真實 LINE user ID、Email、電話、token 或密碼寫進測試 fixture、文件或 commit。

## 驗證與上線

```bash
npm ci --include=dev
npm test
```

- Netlify build 可能因 production install 移除 `jsdom`；部署後要再測試時，先重裝 dev dependencies。
- UI 變更至少驗證桌機後台、390px 手機活動頁、console error 與水平溢出。
- 上線前再次確認 `origin/main` 沒有新提交；以可追溯 commit 合併後再部署。
- Production deploy 後檢查 `/healthz`、`/healthz/db`、受影響頁面與靜態資源。
- 不以 HTTP 200 取代功能驗收；抽獎、邀請、群發等高風險功能要跑相應回歸測試。

## 文件維護

若改動產品功能、路由、資料表、環境變數、排程或部署方式，必須同步更新 `docs/AI_HANDOFF.md` 與必要的 `.env.example`。文件不能記錄任何 secret。
