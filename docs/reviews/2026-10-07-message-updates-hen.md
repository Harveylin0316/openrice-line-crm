PR title：feat: 加入好友歡迎訊息、統一訊息成效與 Campaign 人工確認

## 這次要做什麼

讓管理員從現有訊息庫設定加入好友／解除封鎖歡迎訊息，並在同一入口查看歡迎、群發、自動化與關鍵字回覆的成效及發送紀錄。Campaign 可以先測試 A/B，再由人工確認 Winner；隔天使用動態名單發送時，可排除原測試對象並沿用原版訊息快照。

本 PR 已完成本機實作與驗證，尚未 push 或部署固定 Staging，不能據此直接核准正式上線。

## 改了哪些地方

- 功能／路由：加入好友歡迎設定 `/admin/welcome-messages`；統一成效 `/admin/message-performance`；發送紀錄 `/admin/push-logs`；新訊息點擊 `/t/e`、`/games/t/e`；Campaign 人工 Winner、排除批次與後續群發。
- 主要檔案：`src/core/welcomeMessages.js`、`messageExecutions.js`、`messageTrackingTargets.js`、`messagePerformance.js`、`broadcastAudienceExclusions.js`、`flowEngine.js`；對應 admin／tracking／webhook routes、EJS views、public scripts 與回歸測試。完整接手說明見 `docs/AI_HANDOFF.md`。
- 用戶路徑：設定 → 加入好友歡迎訊息 → 選現有 LINE 素材 → 預覽／保存；首次加入與解除封鎖分開開關。傳訊息 → Campaign Testing → 設定比例與觀察時間 → 到期人工確認 Winner；原批次可建立後續群發，重新計算動態名單並排除原 A/B/C 測試者。
- 訊息格式：沿用文字、圖片、影片、Flex／Carousel、原生 Imagemap 及多段組合；仍遵守最多 5 則。保存完整快照，來源刪除或同圖不同 URL 不互相覆蓋。
- 成效口徑：API 接受不代表已送達／已讀；有效點擊須驗證 LIFF 身分與原收件人。舊群發只有未驗證的跳轉／被點擊收件人連結數，不能視為可靠不重複點擊人數；未知值顯示「—」。Keyword A/B 保留既有完整觀察窗，與新執行紀錄分開計算。
- Campaign 新預設：人工確認、20% A／20% B／60% 保留，比例與觀察小時可改。舊自動批次維持相容；零點擊、平手或資料不足不自動選 A。排除包含原測試者的成功／失敗／等待狀態，不排除原保留組；若同時做保留組 Winner 和後續群發，仍須核對保留組是否重複觸達。

## 風險與資料

- [ ] 不會修改正式資料或 schema
- [x] 若有 migration，已附上 migration、影響評估與 rollback SQL
- [x] 沒有將 token、密碼、LINE User ID、Email 或電話寫入 commit
- [x] 不會誤觸群發、抽獎、邀請、排程或其他 production 寫入

第一項未勾：本次未碰正式資料，但未來正式啟用需新增三個資料表，須由 Hen 核准。其餘勾選指本次開發／驗證行為；正式啟用後歡迎、自動化與發送本來就會寫執行紀錄並依操作發訊息。

測試 fixture 只含明確標示 STAGING 的假 ID、假本機密碼，不含真實個資／憑證。

功能 commit：`9429ae8`（本機 staging，尚未 push）。

Migration：`supabase/migrations/20261005090000_message_executions_welcome.sql`。
Rollback：`supabase/rollbacks/20261005090000_message_executions_welcome_rollback.sql`。

新增 `crm_message_executions`、`crm_message_clicks`、`crm_welcome_settings`，含唯一鍵、索引及 RLS；歡迎預設停用、不回填歷史。僅在隔離本機 PostgreSQL 套用，尚未套固定 Staging。維護者須明確選取 crm_staging schema，在 transaction 內執行 migration，確認 staging role 權限後 commit；不得在預設 public 執行。沒有 runtime DDL。

啟用歡迎前需確認 LINE 原生歡迎與既有 follow 流程，避免重複。發送結果不明不盲目重送；普通 flow 僅針對明確 429 拒絕重試，沿用快照。大型動態 pool 目前整批讀入記憶體，尚未做大量資料壓力測試。

## 怎麼驗證

- [x] `npm ci --include=dev`
- [x] `npm test`
- [x] `git diff --check origin/main...HEAD`
- [ ] 已在固定 Staging 站實際走過受影響用戶路徑
- [x] UI 改動已驗證桌機與 390px 手機畫面、console 無錯誤

UI 勾選僅代表本機隔離 QA。歡迎保存／重載／預覽、成效篩選、發送紀錄、Campaign 人工模式／可調觀察時間／排除清單／草稿重載已操作。桌機 viewport 1440px，文件寬 1425px；手機 viewport 390px，文件寬 375px（含瀏覽器捲軸差異），無水平溢出。未在 UI 點擊實際 LINE 發送或 Winner 發送；並行與 payload 由 mock／隔離資料庫驗證。

測試結果：

```text
npm ci --include=dev: PASS
npm test:
  tests 516
  pass 516
  fail 0
  skipped 0
  cancelled 0

CRM_QA_ISOLATED=1 node scripts/qa/message-updates-check.cjs:
  PASS migration / idempotent apply / empty rollback and reapply
  PASS RLS and staging-role grants
  PASS same-event unknown -> first-follow evidence upgrade exactly once
  PASS concurrent welcome claim / begin / snapshot / revision
  PASS performance SQL / Taiwan dates / action counts
  PASS dynamic pool 1283 -> 1400; exclude 770 -> 630 remain
  PASS unified logs / execution deduplication / detail joins
  PASS two concurrent Winner releases -> one B batch
  PASS rollback refuses retained execution or click history

git diff --check: PASS
git diff --check origin/main...HEAD: PASS
Actual LINE sends: 0
Fixed Staging deployment verification: NOT RUN
```

安裝輸出另列既有依賴稽核 23 項（3 low／2 moderate／16 high／2 critical）；本波未修改依賴或宣稱已清除弱點，未執行會帶 breaking changes 的 audit fix。

仍需完成：使用者 push 後，確認固定 Staging 部署版本、黃色橫幅、migration、歡迎保存／各格式預覽、成效／紀錄／CSV、Campaign 預覽與動態名單操作、桌機與 390px console。LINE 真機首次加入／解除封鎖、各格式實收與 LIFF 點擊，需要另取得授權且只能使用指定測試帳號；不可為驗收把正式金鑰放入固定 Staging。

## 畫面證據

固定 Staging 網址：https://staging--openrice-line-crm.netlify.app （目前不是本波修改的部署證據）。

本機合成資料截圖在專案外 `message-updates-evidence`：

- `welcome-desktop.png`、`welcome-390.png`：歡迎設定與預覽。
- `performance-desktop.png`、`performance-390.png`：來源成效、等待與結果不明分開。
- `push-logs-desktop.png`、`push-logs-390.png`：統一發送紀錄。
- `campaign-desktop.png`、`campaign-390.png`：人工 Winner、20/20/60 與可調觀察時間。

貼到 GitHub description 時，請將以上圖片拖入描述框，再保留 GitHub 產生的圖片 Markdown。本機圖片不會隨複製本文件自動上傳。本波為新增入口，沒有宣稱已提供舊版對照截图。

## 如何回滾

1. 尚未啟用、沒有執行／點擊資料時：執行 `git revert 9429ae8`，功能程式回到 `c1ecb72` 的狀態（不要 force push）；資料庫在已確認的同 schema transaction 內套用上述 rollback SQL。先停用並處理 managed welcome flow，否則 SQL 會拒絕。
2. 已經寄出訊息時：先在歡迎設定取消啟用並保存；暫停受影響的 automation／keyword 規則及尚未發送的 Campaign，不再釋出 Winner。保留三表與 `/t/e`、`/games/t/e`、成效 reader，避免已寄連結失效；不要整包 revert 或 drop 表。
3. 需要退回舊 flow／keyword 發送程式時：先停 managed welcome flow 並保持歡迎停用，再將 `src/core/flowEngine.js`、`src/routes/lineWebhook.js` 還原到 `c1ecb72`，在 staging 完整驗證後走同一審核／部署程序。新追蹤 reader 與歷史資料保留。任何正式回滾仍須 Hen 核准。

已發出的 LINE 訊息無法撤回。Rollback SQL 遇到歷史資料會拒絕執行，不能靠刪除資料繞過。

## Hen 核准

- [ ] Hen 已確認固定 Staging 與上述風險
