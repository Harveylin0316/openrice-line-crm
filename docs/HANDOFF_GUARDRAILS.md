# LINE CRM 安全交接與復原手冊

這份文件定義同事或 AI 接手後的正常工作流程。目標是讓對方能獨立開發，但不能未經 Hen 核准就改壞正式站或正式資料。

## 穩定復原點

- Git tag：`stable-2026-09-16-handoff`
- Source commit：`b7940ce3bfbf127dd50cf862083ce79a12720c5d`
- 交接前 Netlify production deploy：`6aaa148663141f89791982b3`
- GitHub Release：`stable-2026-09-16-handoff`

Git tag／Release 只包含程式，不包含 Supabase 資料與 Storage；資料庫復原必須使用獨立備份。

## 每次改動的正常流程

1. 完整閱讀 `AGENTS.md` 與 `docs/AI_HANDOFF.md`。
2. `git fetch origin`，從最新 `origin/main` 建立新分支。
3. 只修改本次任務範圍，不順手重構或移除既有功能。
4. 執行 `npm ci --include=dev`、`npm test` 與 `git diff --check origin/main...HEAD`。
5. 開 Pull Request，完整填寫 PR 樣板。
6. 在 Netlify Deploy Preview 上實際驗證；不直接發布 production。
7. 由 Hen 審核並合併後，才由 GitHub `main` 觸發 production deploy。

## 接手者可以做的事

- 開功能分支、commit、push 與 Pull Request。
- 在本機與 Deploy Preview 使用測試資料驗證。
- 補測試、文件、截圖、風險說明與 rollback 步驟。

## 未經 Hen 核准不可做的事

- merge／force-push／刪除 `main`。
- 使用 Netlify CLI、API 或 UI 直接發布 production。
- 讀取、複製或更換 production secret。
- 執行 Supabase migration、批次更新、資料回填或刪除。
- 發送正式 LINE 群發、Email、排程、抽獎或修改獎品庫存。
- 修改 LINE OA／LIFF／Webhook 的正式設定。

## 發生問題時

1. 先暫停新的 production deploy 與寫入操作。
2. 記錄現象、時間、受影響路徑與 deploy／commit ID。
3. 程式問題優先將 Netlify 回滾到上一個已驗證 deploy，或從 `stable-2026-09-16-handoff` 建立復原 PR。
4. 資料問題不可只回滾程式；先保留現場，再使用 Supabase 備份／PITR 或已審核 SQL 復原。
5. 復原後重跑 health、DB health 與受影響功能的實際用戶路徑。
