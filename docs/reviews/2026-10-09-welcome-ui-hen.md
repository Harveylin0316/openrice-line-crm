PR Title：feat: 將好友歡迎訊息移至傳訊息，改善設定與即時預覽

以下為本次 UI 更新（`e6deb27`）的驗收，不取代 staging 其他累積改動的 review。Base：main；Compare：staging。尚未合併正式站。

## 這次要做什麼

加入好友歡迎訊息原本藏在「設定」，操作時也不容易知道會發送哪份內容。這次將入口移至「傳訊息」，以發送情境、歡迎內容、啟用與儲存三區呈現，並提供即時預覽與取消變更。

## 改了哪些地方

- 功能／路由：`/admin/welcome-messages`；「傳訊息」共用導覽新增歡迎入口，「設定」分類移除歡迎入口。
- 主要檔案：`views/layout.ejs`、`views/admin_welcome_messages.ejs`、`public/admin-welcome-messages.js`、`public/admin-welcome-messages.css`、`test/welcome-editor.test.js`、`docs/AI_HANDOFF.md`。
- 用戶路徑：傳訊息 → 加入好友歡迎訊息 → 選發送情境 → 選既有素材並預覽 → 確認啟用狀態 → 儲存。可直接前往訊息成效與發送紀錄。
- 保留文字、圖片、影片、Flex／Carousel、原生 Imagemap、多段訊息的既有組裝與快照流程。已儲存內容不隨素材庫更新；「套用素材最新版」須儲存才生效。取消變更還原原設定與預覽。
- 素材名稱以文字呈現；素材 ID 驗證、已刪素材的快照保留、過期預覽回應處理、啟用重複歡迎確認、無測試人員／有未儲存內容時禁止測試均有保護。

## 風險與資料

- [x] 不會修改正式資料或 schema
- [x] 若有 migration，已附上 migration、影響評估與 rollback SQL（本次無 migration，無 SQL rollback）
- [x] 沒有將 token、密碼、LINE User ID、Email 或電話寫入 commit
- [x] 不會誤觸群發、抽獎、邀請、排程或其他 production 寫入

只改介面，沒有改後端發送、權限、追蹤或資料表。固定 Staging 確認 `appEnv=staging`、`safePreviewMode=true`、LINE token 未設定。驗證時暫改「解除封鎖」選項並存檔／重載，結束已還原原值；歡迎始終停用，素材與快照未改。設定 revision／更新時間因測試儲存正常遞增。

## 怎麼驗證

- [x] `npm ci --include=dev`
- [x] `npm test`
- [x] `git diff --check origin/main...HEAD`
- [x] 已在固定 Staging 站實際走過受影響用戶路徑
- [x] UI 改動已驗證桌機與 390px 手機畫面、console 無錯誤

測試結果：

```text
npm ci --include=dev: exit 0
npm test: 542 tests / 542 pass / 0 fail / 0 skipped
新歡迎 editor 回歸: 6/6 pass
既有 welcome routes/core: 4/4 pass
規定 diff check: exit 0
固定 Staging 前端 JS 與 e6deb27 本機檔案逐位元一致
桌機: viewport 1440 / document scrollWidth 1440
手機: viewport 390 / document scrollWidth 390
群發入口手機: viewport 390 / document scrollWidth 390
Console error: 0
```

固定站已驗證：從群發頁進入歡迎設定、保存情境與重載、套用最新版的待儲存狀態、取消還原；「文字＋Imagemap」順序與區域動作顯示；更換同圖異 URL 的 Imagemap B 後顯示 variant=b，取消後恢復原快照的 variant=a；文字＋Flex＋圖片的多段預覽；空測試名單顯示說明並停用按鈕。

自動化回歸包含：初始快照自動預覽、不偷偷保存、改選／取消、refresh 與 revision 保存、啟用確認、已刪素材安全顯示、不合法／Email 素材排除、過期預覽錯誤不覆蓋新畫面、載入失敗鎖住操作及導覽分類。

未執行真人發送或 LINE 實收；未在固定站逐一建立影片／所有 Carousel 變體。共用預覽与組裝未變更，完整既有回歸通過，不能把本次瀏覽器驗證視為真人實收驗收。

安裝摘要另有既有依賴 audit 提示（23 項：3 low、2 moderate、16 high、2 critical）與兩套件安裝腳本待核准提示；安裝及測試均成功。本次未更動依賴或執行強制升級。

## 畫面證據

固定 Staging：https://staging--openrice-line-crm.netlify.app/admin/welcome-messages

附件檔案（請將 PNG 拖入 GitHub description，GitHub 會產生可分享的圖片連結；本機檔案路徑不會自動上傳）：

1. `before-desktop.png`：改版前固定站介面。
2. `after-desktop.png`：改版後固定站桌機，含傳訊息導覽與文字＋滿版圖文預覽。
3. `after-mobile-390.png`：改版後固定站 390px 手機、完整設定與預覽。

## 如何回滾

在 staging 執行 `git revert e6deb27`，保留後續提交，完成測試後循正常 staging push／Hen 核准流程部署。此動作還原 UI 到 `db25780` 的行為，不刪除歡迎設定、快照、成效紀錄或資料表。無 SQL rollback。

回滾 UI 不會自動停用已啟用的歡迎流程；若營運需暫停發送，管理員需先在歡迎設定關閉並儲存。已發送的 LINE 訊息無法撤回。

## Hen 核准

- [ ] Hen 已確認固定 Staging 與上述風險
