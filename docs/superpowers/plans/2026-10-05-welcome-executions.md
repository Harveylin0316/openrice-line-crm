# 歡迎訊息與執行資料 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以既有 follow 流程提供全樣式歡迎訊息設定，保存可去重、可追蹤的執行快照。
**Architecture:** 新增共用 execution store 作為新歡迎與缺失事件的資料來源。歡迎設定管理一個專用 follow flow，existing flows 保持原行為；事件申領與 enrollment 在同一交易完成。
**Tech Stack:** pg/PostgreSQL、Express、EJS、node:test/JSDOM。
**Spec:** ../specs/2026-10-05-welcome-message-performance-design.md

## Global Constraints

繼承索引的 Global Constraints。migration 僅在隔離環境驗證；新歡迎預設停用。全程沿用 buildLineMessages 與原生 imagemap。

## Review Focus

- 同 follow 事件在已完成後重送不能再次建立 enrollment。
- follow 狀態未知不可被當成首次。
- 已啟用舊 follow flow 不自動關閉，也不可被新設定編輯覆蓋。
- 停用與 runner 競態要在開始送出前重新檢查；已被 LINE 接受無法撤回。
- migration 尚未套用時原有 webhook 正常，新功能顯示未啟用而非假成功。

### Task 1: Execution store 與隔離 migration

**Files:** 新增 `src/core/messageExecutions.js`、`supabase/migrations/20261005090000_message_executions_welcome.sql`、`supabase/rollbacks/20261005090000_message_executions_welcome_rollback.sql`、`test/message-executions.test.js`、`scripts/qa/message-executions-check.cjs`。

**Interfaces:** `createMessageExecutionStore({pool,query})` 回 `{claim,finish,get}`；`claim(client,input)` 回 `{claimed,execution}`，input 包含 sourceType/sourceId/sourceEventId/recipientKey/messageSnapshot/targets/variant/testOnly；`finish(id,{status,reason})` 只允許合法狀態遷移。未解析的逾時為 uncertain，不允許新 key 重送。

- [ ] 測試同 sourceType/sourceId/sourceEventId/recipientKey 唯一申領、拒絕不合法狀態、快照不隨素材變更、testOnly 隔離、accepted 不被晚到失敗覆蓋；先跑 `node --test test/message-executions.test.js` 確認失敗。
- [ ] 建表 `crm_message_executions`（上述身份唯一鍵、JSONB snapshot/targets、variant、status、reason、created_at/finished_at、opaque random code unique），`crm_message_clicks`（execution_id、action_index、verified identity nullable、event key、timestamp、unique execution/event key），`crm_welcome_settings`（單例主 OA、enabled=false、首次／解除封鎖設定、snapshot、revision、managed_flow_id、updated_by）。時間索引、來源索引與 FK 限於目前 schema；個資欄位僅伺服器可讀。
- [ ] 加 RLS、撤銷 PUBLIC/anon/authenticated、新表 sequence 權限；參照 keyword A/B migration 的 staging 專用 policy。rollback 明示先停寫並備份，仍有對外追蹤資料時預設拒絕破壞性 drop；不刪既有 flow 表。
- [ ] QA script 僅 localhost 隔離 PG，驗證 migration 重跑、實際角色 CRUD、跨 schema 不可讀、兩連線 claim 一次、rollback 空表與有資料保護。PASS 後 commit `feat: add immutable message execution records`。

### Task 2: 歡迎設定與 follow 執行

**Files:** 新增 `src/core/welcomeMessages.js`、`src/routes/adminWelcomeMessages.js`、`views/admin_welcome_messages.ejs`、`public/admin-welcome-messages.js`、`test/welcome-messages.test.js`、`test/welcome-messages-ui.test.js`；修改 `src/app.js`、`src/routes/lineWebhook.js`、`src/core/flowEngine.js`、`src/core/linePush.js`、`views/layout.ejs`。

**Interfaces:** `classifyFollow({isUnblocked,hadPriorFriendEvidence}) -> 'first'|'unblocked'|'unknown'`；`createWelcomeService({pool,query,executionStore})` 回 `{load,save,claimFollow}`。`triggerFollow(lineUserId,userId,evidence={})` 新參數包含 webhookEventId 與已驗簽 follow 分類，舊兩參數呼叫不變。`claimFollow(client,event)` 與專用 enrollment 同交易；context 保存 executionId、welcomeRevision、messageSnapshot。只對 managed welcome flow 走新邏輯。

- [ ] 寫失敗測試：first/unblocked/unknown、關閉、重送／已完成再重送、兩事件並行、DB 失敗不發送、素材刪除仍使用快照、啟用前必須確認既有 follow 發訊提示。`node --test test/welcome-messages.test.js test/welcome-messages-ui.test.js` 應先 FAIL。
- [ ] 實作 GET/POST `/admin/welcome-messages` 與 preview/test API，沿用 requireAdmin、訊息庫 list/preview、validateMessageConfig；保存帶 revision 防止兩分頁覆寫。僅建立／更新自家 managed flow；列出現有 follow 發訊流程，不改它們。
- [ ] 組裝 payload 時使用保存快照與共用 builder；各格式 UI 不 hardcode card/flex 白名單。sender 增加兼容的 detailed push 結果供新歡迎使用，原 boolean 呼叫者不改；不確定狀態停止新歡迎自動重試。處理 LINE 冪等回應時保留同執行識別。
- [ ] 測試停用後尚未開始的節點略過；資料表不存在原 follow 流程照常、新頁面明示 migration 未套用；未知 follow 不發迎新、不更動邀請獎勵。重送唯一鍵優先使用驗簽 webhookEventId，缺少時以已驗簽原事件穩定 hash（非目前時間）建立，無足夠證據略過。
- [ ] 六類素材與混排的 API/儲存/重載/預覽/實際 sender mock payload 回歸；缺 snapshot 或超過五則拒絕；測試發送標 testOnly 且 safe preview 禁外送。
- [ ] 執行 `node --test test/welcome-messages.test.js test/welcome-messages-ui.test.js test/flow-trigger-constraint.test.js test/flow-schedule-resume.test.js test/line-imagemap-sender.test.js`；隔離 PG follow claim 並行驗證；更新 AI_HANDOFF，PASS 後 commit `feat: configure welcome messages through follow automation`。
