# Campaign 人工確認與動態名單排除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者可以等觀察期結束才手動發保留名單，亦可對動態 pool 排除指定測試批次後另行發送。
**Architecture:** 沿用 experiment JSON、固定收件人與現有 release row lock。排除邏輯在共用 audience 層執行，所有入口先排除再抽樣；隔日補送是獨立批次。
**Tech Stack:** Express、pg、EJS、node:test/JSDOM。
**Spec:** ../specs/2026-10-05-welcome-message-performance-design.md

## Global Constraints

繼承 `2026-10-05-message-updates.md` 的 Global Constraints。此子計畫不新增 schema，設定保存在既有 JSON；任何必要索引須正式 migration。

## Review Focus

- 舊 auto 不能被新預設 manual 覆寫；缺少 mode 的舊批次讀取仍依原 auto 行為。
- 明確 mode 非 manual/auto 應拒絕，不能靜默切成 auto。
- 日期缺漏／非法、到期前的直接 API 操作不應釋出。
- 兩人重按與 cron 同時執行只建立一份保留批次。
- 名單組成改變但人數相同，也須讓舊預覽失效。

### Task 1: 人工發送方式與安全釋出

**Files:** 修改 `src/core/campaignExperiment.js`、`src/routes/adminBroadcast.js`、`public/admin-broadcast.js`、`views/admin_broadcast.ejs`、`views/admin_broadcast_detail.ejs`；測試 `test/campaign-experiment.test.js`、新增 `test/campaign-manual-release.test.js`。

**Interfaces:** `normalizeCampaignExperiment(raw)` 新建時 `winner_mode` 預設 manual，保留現有 return shape；`resolveCampaignWinner(rows, variants)` 回 `{winner, reason, stats}`，reason 為 winner/insufficient_delivery/no_clicks/tie；`canReleaseExperiment(experiment, now)` 回 `{ok,error}`。既有 `releaseExperimentWinner` 在交易鎖內使用以上結果。

- [ ] 寫失敗測試：`normalizeCampaignExperiment({...valid,winner_mode:'manual'}).value.winnerMode === 'manual'`；未知字串拒絕；新建缺值 manual；讀舊 JSON 不改 auto；草稿重載保持 mode。`resolveCampaignWinner([{variant:'a',sent_ok:10,clickers:0},{variant:'b',sent_ok:10,clickers:0}],['a','b']).winner === null`；任一版零成功與 CTR 平手皆 null。
- [ ] 執行 `node --test test/campaign-experiment.test.js test/campaign-manual-release.test.js`，確認新案例先失敗。
- [ ] 實作上述純函式、建立／草稿欄位與詳情頁。新建預設 20/20/60，仍可自訂；顯示 `allocationCounts` 的實際人數，50/50 無保留導向普通 A/B，不更改 Campaign 的正保留組規則。
- [ ] 在 release 鎖內驗證 winnerAt 存在且到期；cron 只處理 auto。無可用勝出則保存待確認原因、切 manual，不建立新批次；指定人工版本保留操作者、時間、統計快照及人工標記。不得先送出再 commit。
- [ ] route 測試加入 manual 到期 runner 零釋出、到期前／日期異常回 409、A/B/C 合法性、double release 已釋出 ID 相同、無 CTA 仍拒絕；隔離 PG 兩連線並行只建一批。詳情頁不再預選不存在的 A winner；將此區「成功送達」改為「API 接受發送」。
- [ ] 重跑上述測試及 `node --test test/broadcast-sequence-ab.test.js test/broadcast-play-grant.test.js`；全 PASS 後 commit `feat: add manual Campaign winner approval`。

### Task 2: 共用名單排除與預覽一致性

**Files:** 修改 `src/core/broadcastAudience.js`、`src/routes/adminBroadcast.js`、`public/admin-broadcast.js`、`views/admin_broadcast.ejs`；新增 `src/core/broadcastAudienceExclusions.js`、`test/broadcast-audience-exclusions.test.js`；沿用 `test/broadcast-recipient-selection.test.js`。

**Interfaces:** `normalizeExcludedBroadcastIds(raw)` 回排序去重的安全正整數陣列，最多 20 筆，非法值拒絕；conditions 欄位 `excludeBroadcastIds`。`loadExcludedTestRecipients(query, ids)` 回 Set<LINE user ID>，先核對批次存在、LINE 管道、A/B 或 Campaign 設定；排除 variant a/b/c，包含所有狀態但不含 holdout。`audienceRevision(recipients)` 回排序去重身份的 SHA256，只用於伺服器簽署／比對。

- [ ] 寫失敗測試：pool 1,400 包含原 770 → 630；某測試對象退出不多扣；重複名單不多扣；failed/pending/uncertain 仍排除；holdout 保留；非法／不存在／Email 批次拒絕；查詢故障無建立批次。驗證同總數換人 revision 不同。
- [ ] 執行 `node --test test/broadcast-audience-exclusions.test.js` 確認先失敗。
- [ ] 將排除插入 previewAudience 與 fetchAudienceRecipients 的共用候選計算，在 limit/random 前執行；涵蓋條件、saved list、explicit IDs。查詢使用參數，不將排除集合回傳給前端。
- [ ] Preview 回傳簽署 token，含候選 revision、正規條件、channel、selection、到期時間（10 分鐘）。只在啟用排除的新流程要求 token；建立時重新同步動態名單、比對後在同一隔離交易固定選取，變動回 409 `audience_preview_stale` 要求重預覽。不能只比對數量，也不能相信前端自行提交 hash。
- [ ] UI 顯示排除批次、候選數／排除數／本次數、預覽時間；修改條件即清空 token。route 測試所有入口、limit 順序、token 篡改／逾時及同人數不同組成；前端測試草稿與重新預覽。
- [ ] 執行 `node --test test/broadcast-audience-exclusions.test.js test/broadcast-recipient-selection.test.js test/broadcast-recipient-audit.test.js`；PASS 後 commit `feat: exclude prior test cohorts from dynamic audiences`。

### Task 3: 隔日選版補送入口

**Files:** 修改 `src/routes/adminBroadcast.js`、`public/admin-broadcast.js`、`views/admin_broadcast_detail.ejs`；新增 `test/broadcast-followup-audience.test.js`。

**Interfaces:** 登入保護 GET `/admin/broadcast/:id/followup-config?variant=a|b|c` 回 `{message_config,sourceBroadcastId,sourceVariant,conditions}`；內容取原批次版本快照，conditions 注入來源排除 ID。新批次 `audience_config.followupOf` 保存 `{broadcastId,variant}`，後端重新核對內容與來源，不信任瀏覽器快照。

- [ ] 測試同圖異 URL 選 B 完整保留 UTM；刪除素材不影響；沒有 variant 拒絕；原 holdout 不擴張；新批次報表不歸入原測試；來源取消或發送失敗不撤除排除資料。
- [ ] 執行 `node --test test/broadcast-followup-audience.test.js` 確認失敗後實作上述 API 與「用此版本建立後續群發」入口，只帶入草稿，絕不自動送出。動態 pool 與固定 holdout 明確分開。
- [ ] 重跑本計畫所有測試；更新 `docs/AI_HANDOFF.md`；commit `feat: prepare follow-up broadcasts from frozen test variants`。
