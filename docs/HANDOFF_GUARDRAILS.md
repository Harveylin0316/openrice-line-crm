# LINE CRM 安全交接與復原手冊

這份文件定義同事或 AI 接手後的正常工作流程。目標是讓對方能直接更新固定測試站、自己反覆 Review，同時不能未經 Hen 核准改動正式站或正式資料。

## 穩定復原點

- Git tag：`stable-2026-09-16-handoff`
- Source commit：`b7940ce3bfbf127dd50cf862083ce79a12720c5d`
- 交接前 Netlify production deploy：`6aaa148663141f89791982b3`
- GitHub Release：`stable-2026-09-16-handoff`

Git tag／Release 只包含程式，不包含 Supabase 資料與 Storage；資料庫復原必須使用獨立備份。

## 日常更新測試站

1. 完整閱讀 `AGENTS.md` 與 `docs/AI_HANDOFF.md`。
2. 執行 `git fetch origin`、`git switch staging`、`git pull --ff-only origin staging`。
3. 只修改本次任務範圍，不順手重構或移除既有功能。
4. 執行 `npm ci --include=dev`、`npm test` 與 `git diff --check`。
5. commit 後先執行 `git pull --rebase origin staging`，處理同事剛推上的變更，再 `git push origin staging`。不得 force push。
6. 等待 Netlify 自動更新固定測試站 `https://staging--openrice-line-crm.netlify.app`，登入後實際走過受影響路徑。
7. 若需要再調整，重複以上流程；更新測試站不需 Hen 核准，也不必每次建立 Pull Request。

## 正式上線流程

1. 先在固定測試站完成驗收，確認 `staging` 是要上線的版本。
2. 建立 `staging -> main` Pull Request，完整填寫 PR 樣板、測試證據、正式資料影響與 rollback。
3. 由 Hen Review 與核准合併；接手者和 AI 不自行 merge `main`。
4. `main` 合併後才會觸發 production deploy，並需驗證正式 health、DB health 與受影響功能。

## 接手者可以做的事

- 直接在 `staging` commit、正常 push，讓固定測試站自動更新。
- 在本機與固定測試站使用測試資料驗證。
- 必要時建立暫時功能分支，整合後再推回 `staging`。
- 補測試、文件、截圖、風險說明與 rollback 步驟。

## 未經 Hen 核准不可做的事

- push／merge／force-push／刪除 `main`。
- force-push／刪除 `staging`。
- 使用 Netlify CLI、API 或 UI 直接發布 production。
- 讀取、複製或更換 production secret。
- 對正式 Supabase 執行 migration、批次更新、資料回填或刪除；Staging 僅可操作 `crm_staging`。
- 發送正式 LINE 群發、Email、排程、抽獎或修改獎品庫存。
- 修改 LINE OA／LIFF／Webhook 的正式設定。

## 發生問題時

1. 先暫停新的 production deploy 與寫入操作。
2. 記錄現象、時間、受影響路徑與 deploy／commit ID。
3. 程式問題優先將 Netlify 回滾到上一個已驗證 deploy，或從 `stable-2026-09-16-handoff` 建立復原 PR。
4. 資料問題不可只回滾程式；先保留現場，再使用 Supabase 備份／PITR 或已審核 SQL 復原。
5. 復原後重跑 health、DB health 與受影響功能的實際用戶路徑。
