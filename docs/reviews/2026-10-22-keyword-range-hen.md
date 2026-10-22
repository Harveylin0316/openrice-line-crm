# PR title

feat: 關鍵字回覆新增期間統計與時段圖表，修正重送去重及手機操作

## 這次要做什麼

讓同事可以選開始日與結束日，查看每條關鍵字規則在該期間的觸發紀錄，以及每天、每小時、一天中各時段的分布。保留原本累計數，並修正歷史重送重複計數、延遲處理漏算及快速切換日期顯示舊數字的問題。

## 改了哪些地方

- 功能／路由：`/admin/keyword-replies`、唯讀 `GET /admin/keyword-replies/api/stats`；預設近 7 天，支援今天、昨天、近 30 天、自訂日期，最多 366 天；每小時模式最多 7 天。
- 主要檔案：`src/routes/adminKeywordReplies.js`、`views/admin_keyword_replies.ejs`、`test/keyword-reply-stats.test.js`、`scripts/qa/keyword-range-review.cjs`、`docs/AI_HANDOFF.md`。
- 用戶路徑：傳訊息 → 關鍵字回覆 → 選起訖日期 → 套用 → 每條規則「紀錄」→ 切換圖表。手機規則以卡片排列，紀錄按鈕可直接操作。
- 日期以台灣時間計算，包含結束日全天。依事件／訊息編號去重後統計，同事件有已接受結果時保留已接受結果；延遲處理仍按原始訊息日歸類。
- 查詢載入與失敗時清除舊結果，過期回應不覆蓋新日期／新規則。非法日期、反向區間與過長範圍會拒絕。

## 風險與資料

- [x] 不會修改正式資料或 schema
- [x] 若有 migration，已附上 migration、影響評估與 rollback SQL（本次無 migration，不需要 SQL）
- [x] 沒有將 token、密碼、LINE User ID、Email 或電話寫入 commit（測試識別皆為 STAGING 合成資料）
- [x] 不會誤觸群發、抽獎、邀請、排程或其他 production 寫入

指標限制：

- 觸發次數是「已保存且可辨識規則的觸發紀錄」，不是保證完整的歷史訊息數。未完成處理、記錄失敗或無規則編號的異常無法補算。
- 成功回覆表示紀錄顯示 LINE 接受，不代表送達或已讀。
- 舊 failed 紀錄也包含結果不明及測試跳過，因此畫面稱「未確認成功」，不能當成確定失敗。
- 不重複人數只計有識別資料的觸發者；同一人重複觸發仍只算一人。
- 最早可查紀錄日不代表自該日起完全無遺漏。歷史紀錄若事件與訊息編號皆缺少，無法保證完整去重。
- 只讀既有 webhook 紀錄，沒有資料回填。固定 Staging 驗收規則「STAGING 日期篩選驗收 20261022」保持停用，沒有真人發送。

## 怎麼驗證

- [x] `npm ci --include=dev`
- [x] `npm test`
- [x] `git diff --check origin/main...HEAD`
- [x] 已在固定 Staging 站實際走過受影響用戶路徑
- [x] UI 改動已驗證桌機與 390px 手機畫面、console 無錯誤

測試結果：

```text
npm ci --include=dev: PASS
npm test: 613 tests / 613 pass / 0 fail
git diff --check origin/main...HEAD: PASS
固定 Staging（1b818de）: PASS
每日7格 / 每小時168格 / 24時段合計 / 每小時超過7天提示: PASS
桌機1440px與手機390px: 無水平溢出、正常操作console無錯誤
測試站無觸發事件；以停用STAGING規則驗證零資料與操作，未對真人發送
隔離 PostgreSQL：台灣午夜邊界、重送去重、延遲處理、兜底、未命中排除、三種時間分組、空區間通過。
本機 UI：以合成資料驗證列表、圖表及手機操作；不代表真人 LINE 發送驗證。
```

## 畫面證據

固定 Staging：[關鍵字回覆](https://staging--openrice-line-crm.netlify.app/admin/keyword-replies)。

以下截圖已放在 repo，貼上此文件的 Markdown 即可引用，不用另外上傳圖片。固定 Staging 沒有真實觸發事件，數字正確性由隔離 PostgreSQL 測試驗證；不得將合成資料截圖宣稱為正式資料結果。


**固定 Staging：桌機每日紀錄（零資料）**

![固定 Staging：桌機每日紀錄（零資料）](https://github.com/Harveylin0316/openrice-line-crm/blob/staging/docs/reviews/assets/2026-10-22-keyword-range/staging-desktop-day.png?raw=true)

**固定 Staging：390px 手機規則清單**

![固定 Staging：390px 手機規則清單](https://github.com/Harveylin0316/openrice-line-crm/blob/staging/docs/reviews/assets/2026-10-22-keyword-range/staging-list-mobile.png?raw=true)

**隔離本機：合成資料的24時段圖**

![隔離本機：合成資料的24時段圖](https://github.com/Harveylin0316/openrice-line-crm/blob/staging/docs/reviews/assets/2026-10-22-keyword-range/local-chart-desktop.png?raw=true)

**隔離本機：合成資料的390px規則清單**

![隔離本機：合成資料的390px規則清單](https://github.com/Harveylin0316/openrice-line-crm/blob/staging/docs/reviews/assets/2026-10-22-keyword-range/local-list-mobile.png?raw=true)

## 如何回滾

本功能起始 commit：`977e7a5`，前一版為 `45111d7`。如需撤回整個功能，依序 revert `1b818de`（本次 review 修正），再 revert `977e7a5`，經正常 staging 部署驗證後交 Hen 核准正式回滾；不使用 reset 或 force push。不需刪資料、改 schema 或執行 rollback SQL。

## Hen 核准

- [ ] Hen 已確認固定 Staging 與上述風險
