# 追蹤補齊、成效與交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四種來源能由同一入口查看真實執行結果、段落／動作成效及資料限制。
**Architecture:** 複用計畫 2 的 execution store，新事件以快照索引追蹤；既有群發／關鍵字 A/B 資料由 adapter 讀取。舊連結維持相容，同一次發送只由一個權威資料源計數。
**Tech Stack:** Express、pg、EJS、node:test/JSDOM。
**Spec:** ../specs/2026-10-05-welcome-message-performance-design.md

## Global Constraints

繼承索引 Global Constraints。依序先計畫 1、2，再本計畫；不以 proxy image hit 當已讀，不新增推測訂位歸因。

## Review Focus

- 同圖不同 action URI、素材刪除／修改，已送 URL 不串版。
- 中文標點、URL query/hash、原本追蹤網址不能被純文字轉換破壞。
- 群組／未登入／轉傳的點擊不能冒充原收件人。
- 舊 API accepted boolean 不足以區分 uncertain，歷史資料要明示缺漏。
- 台灣午夜邊界、零分母與查詢失敗不得出現虛構 0% 成效。

### Task 1: 快照目標與新事件的共用追蹤

**Files:** 新增 `src/core/messageTrackingTargets.js`、`src/routes/messageExecutionTracking.js`、`test/message-execution-tracking.test.js`；修改 `src/core/messageTapTracking.js`、`src/core/flowEngine.js`、`src/routes/lineWebhook.js`、`src/core/keywordExperiments.js`、`src/routes/adminBroadcast.js`、`src/app.js`。

**Interfaces:** `collectMessageTargets(messages)` 回 `{targets,warnings}`，target 為 `{index,slotIndex,cardIndex,actionIndex,kind,uri,label}`，kind=uri_action|text_url。`wrapExecutionTargets(messages,targets,urlForIndex)` 回深拷貝 messages；`GET /t/e/:opaqueCode/:index` 由執行快照解析目的地，`POST .../hit` 使用既有 LIFF 伺服器驗證並比對收件人，再寫已驗證事件。

- [ ] 寫失敗測試：same image A/B 仍各到 variant=a/b 且保留 UTM；改素材後仍到原網址；text URL 前後中文標點不丟、括號歧義保留原文並警告、非 HTTP(S) 不處理、已追蹤 URL 不重包、預覽零寫入、同 hit 重送只一筆。`node --test test/message-execution-tracking.test.js` 應先 FAIL。
- [ ] 完成純函式與 opaque tracker 路由，代碼不可含收件人資訊；對外目的地僅從 snapshot 取得，GET 不算有效點擊，hit 驗證失敗仍允許使用者導向原網址但不計有效／unique。計畫 2 新歡迎全部使用此路由。
- [ ] 普通 keyword 與 flow 新發送補 execution claim/finish/targets；有關鍵字實驗則保留既有 experiment delivery 權威紀錄、不雙寫計数。broadcast 保留 recipients 權威結果，新 metadata snapshot 僅補 action/slot 索引及純文字連結，不計第二份接受數。
- [ ] 不更改既有 action 索引：純文字目標追加在舊 URI targets 後，legacy 未保存目標用舊 resolver。原 `/rf`、`/t/m` 留作舊訊息相容；新 flow 點擊仍回寫流程分支需要的既有事件，附去重鍵避免 report double count。
- [ ] 寫 cross-source 整合測試及 DB 失敗／timeout、被轉傳、非 URI action、私密資料不進 URL／log fixture；測 `node --test test/message-execution-tracking.test.js test/message-tap.test.js test/keyword-reply-ab.test.js test/broadcast-flex-tracking.test.js`；PASS 後 commit `feat: track message actions with immutable source snapshots`。

### Task 2: 統一讀取 adapters、成效與紀錄入口

**Files:** 新增 `src/core/messagePerformance.js`、`src/routes/adminMessagePerformance.js`、`views/admin_message_performance.ejs`、`test/message-performance.test.js`；修改 `src/routes/adminPushLogs.js`、`src/core/pushLogDiagnostics.js`、`views/admin_push_logs.ejs`、`views/layout.ejs`、`src/app.js` 與四種設定頁的連結。

**Interfaces:** `createMessagePerformance({query})` 回 `{summary,details,executions}`；輸入 `{sourceType,sourceId,from,to,variant,cursor}`，日期固定台灣日界線；輸出 `{rows,nextCursor,coverage,metricDefinitions}`。每列保留 `sourceType/sourceId/revision`、triggerCount、accepted/rejected/uncertain/skipped、clickCount、uniqueClickers、denominator、rate、rateKind、availabilityReason。不可用 null 轉為 0。

- [ ] 寫失敗測試：同素材不同來源分列、broadcast recipients 與補充 execution 不雙加、welcome 不再列入普通 automation、既有 keyword A/B 觀察窗不改、舊未知人數為 null、無 target 不適用、真零為 0、DB 錯誤非空成功；台灣午夜範圍及分頁同時間資料不跳列。先跑 `node --test test/message-performance.test.js`。
- [ ] adapters 優先讀權威來源：broadcast recipients/clicks；keyword experiment deliveries/clicks；welcome/新普通 keyword/新 flow executions；舊 flow/keyword 的可用 logs/taps 另標 legacy/unknown。每列輸出有效資料時間與口徑，不提供跨來源混算 Winner。
- [ ] 實作登入保護 `/admin/message-performance` 與詳細 API；sourceId/variant 嚴格驗證與 parameter SQL。展開段落／卡片／動作，受權限保護才可查看收件人紀錄；模板 escaping、CSV formula injection、無第三方圖片載入產生假點擊。
- [ ] 擴充 `/admin/push-logs` 合併 reply/execution 結果並保留舊紀錄頁預設、診斷與分頁；新增來源深連結。設定頁「查看紀錄」帶 `status=all`，避免沿用 failed 預設看不到成功；成效入口不修改既有 campaign-performance。
- [ ] 執行 `node --test test/message-performance.test.js test/push-log-diagnostics.test.js test/campaign-performance.test.js test/admin-guided-workflows.test.js`；加入各角色、惡意來源名稱、無資料／缺表／錯誤畫面的 JSDOM 回歸；PASS 後 commit `feat: unify message performance and execution history`。

### Task 3: 全波驗證與使用者 push 交接

**Files:** 修改 `docs/AI_HANDOFF.md`；新增 `docs/reviews/2026-10-05-message-updates-hen.md`、`scripts/qa/message-updates-check.cjs`。證據存於專案外輸出目錄，不把登入資訊與個資放 commit。

**Interfaces:** QA script 僅隔離本機 DB、虛構資料、mock LINE，不讀 production 環境。Review 文件用使用者既有 Hen 格式，PR title 取索引。

- [ ] QA 演練 migration/rollback、兩連線並行 claim/release、動態名單 1,283→1,400 排除 770=630，以及退出集合例子。確認同圖不同連結／所有格式／重載／預覽完整；結果記實際輸出。
- [ ] 執行 `npm ci --include=dev`、`npm test`、`git diff --check origin/main...HEAD` 及 `git diff --check`；有失敗先修，不用跳過測試換取通過。
- [ ] 本機桌機／390px 驗證所有新路徑、console 與水平溢出，保存截图；不能當固定 Staging 已驗證。
- [ ] 更新交接文件與 migration 操作說明；Hen 格式列實際測試、檔案、資料風險、尚未完成的固定站與真人驗收。逐 commit revert 次序先 UI/report，再 welcome 執行；保留追蹤相容 reader，schema 不自動 drop，說明已送訊息無法撤回。
- [ ] 做一次全差異獨立審查，修正發現後只重跑受影響測試及完整必要檢查。只提交本波明確檔案，不 stage 他人更動。
- [ ] 交付可讓使用者 push 的 staging commits、PR title、可貼 description。使用者 push 後再驗證固定 Staging 黃色橫幅、部署版本、桌機／390px 与 console；未經授權不補 LINE 金鑰或真人發送。Hen 核准保持未勾選。
