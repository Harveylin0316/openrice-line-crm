# LIFF 關閉後空白視窗：候選修正與交付

狀態：程式候選，sender 預設關閉。尚未完成 iPhone 真機驗收，不能宣稱已修復；沒有修改 production 或重發訊息。

## 原因與改法
使用者確認 LIFF 可登錄，按「完成」後留下空白外層視窗，按 X 才回聊天室。正式 HTML 的完成按鈕僅 `liff.closeWindow()`。候選根因是 /r/b → LIFF 留下 LINE 一般瀏覽器；未有手機除錯追蹤證據。

候選把「新訊息」改成直接 LIFF + or_bc 參考碼，由活動登入完成後背景 POST 記錄。無額外用戶按鈕，不改完成按鈕、GAS、活動規則、g/src 分組參數。不是讓網頁強制關閉其他視窗。

## 交付檔案
- `public/broadcast-direct-liff.js`：可嵌入活動 HTML 的輔助程式，僅在初始化後有 or_bc 與 ID token 時運作；不阻擋表單。
- `scripts/qa/package-dineback-direct-liff.cjs`：把已下載的正式 HTML 產成候選，不部署、拒絕覆寫來源／重複整合／不符合預期的插入位置。
- staging HTML 指向 staging API；production HTML 指向 production API。不能互換。任何有 token 的 POST 只送到這兩個固定 CRM 網域之一，不能從網址帶任意接收站。

```bash
node scripts/qa/package-dineback-direct-liff.cjs INPUT.html OUTPUT.html https://staging--openrice-line-crm.netlify.app
```

活動 HTML 必須維持部署到它在 LINE Console 設定的 Endpoint；不可隨便換網址當成同一個 LIFF 的完整驗收。隔離驗收要有獨立測試 LIFF、測試 HTML 與測試 GAS／資料，不能拿 production HTML 連正式 GAS 假稱隔離。現有 production HTML 候選只供工程師 diff／核准後上傳；不得用來製造正式登錄測試資料。

## 設定與順序（Hen 核准正式變更）
1. 先部署 CRM 程式，`BROADCAST_DIRECT_LIFF_ENABLED` 維持未設或 `0`。
2. 設定 `BROADCAST_DIRECT_LIFF_APPS`，JSON map 的 key 是已整合的 LIFF ID，value 是精確 HTTPS Endpoint（不含 query/hash）。例：`{"2007974193-FX5Q5Vhf":"https://tw.openrice.com/info/event/202611-dineback/index.html"}`。這讓 API 可以驗證該活動，但還不改發送連結。
3. 工程師上傳對應 CRM 環境的 HTML；確認它與測試 LIFF Endpoint、測試 GAS 及 allowlist 對應。
4. 在隔離環境建立虛構／授權測試收件人、已送出快照，再產生 direct URL。手機從 LINE 聊天室「直接點該 URL」；不是貼到 Safari 網址列。
5. 通過下面驗收後，Hen 才能核准 production HTML、環境與 main 發布，再設 `BROADCAST_DIRECT_LIFF_ENABLED=1`。不能在正在觀察的 A/B 實驗或正在發送的批次中途切換；先結束／隔離比較窗口。

## 必做真機驗收
- iOS 18.7／LINE 26.12.1：原始直達與帶 or_bc 直達皆正常，完成後直接聊天室，沒有第二層白頁／多一次 X。
- Android：同上；外部瀏覽器仍停留成功頁並顯示既有關閉提示。
- 原收件人一次初始化能記錄；重新整理不增加同按鈕人次。轉傳給別人、錯誤／過期 token、不同 channel、錯版本／未送出收件人均不記錄。
- 原 g/src/fragment 保留；一般 HTTPS 連結／其他 LIFF／測試訊息仍維持原行為。
- demo=1、preview=1 不送追蹤；API 失敗不阻擋登錄或完成。不得送真人推播／派獎驗證。

## 成效語意及限制
- 新 API 記錄的是原收件人成功初始化 LIFF，並非每次手指點擊。仍更新原 clicks 表及 first_clicked_at；報表無新欄位，同按鈕每收件人只計第一次；同時遵守既有 (broadcast_id, recipient_id, target_url) 唯一索引。兩顆按鈕連到完全相同網址時，歸在首次記錄的按鈕，不新增第二筆；已有 legacy 紀錄也不覆寫。
- 舊 /r/b 是 GET 追蹤，可能包含預覽爬蟲；不清除／重算舊數據，也不宣稱歷史數字可直接比較。
- 無效 token、網路封鎖、極快關閉或初始化失敗可能缺記。不是 100% 點擊蒐集保證。
- 已送出的 /r/b 舊連結與 flow／keyword 等其他入口本輪不變，不能藉此修復它們，也不自動重發。
- 不需 migration；交易使用現有 broadcast/recipient/click 表。實際部署角色需有既有 SELECT／INSERT／UPDATE 權限。

## 回滾
關閉 sender 旗標，未來新發送回既有 /r/b。保留已啟用 app 的 allowlist、API 與活動 helper，才能繼續處理已送出的 direct 連結；不要回滾到沒有 API 的版本又聲稱保留追蹤。活動 helper 沒有 or_bc 時不做任何事。無 SQL rollback，無資料刪除。

## 程式驗證
node:test 覆蓋 builder、驗證／拒絕分支、client 失敗隔離與打包原文保留；另用暫存 PGlite 執行真 PostgreSQL SQL、五個排隊請求只插一筆、失敗回滾。PGlite 是單連線引擎，不等於正式多連線鎖競態／手機與雲端驗收。

## 2026-11-17 驗證補記
- 獨立 reviewer 發現既有 URL 唯一索引與按鈕去重衝突；加入相同索引與「第二顆按鈕相同網址／legacy NULL index」案例，先重現 503，再以 ON CONFLICT DO NOTHING 修正通過。無 schema 變更。
- 真實正式 HTML 的兩份候選：移除新增 helper／呼叫標記後，逐字還原原檔；兩個 inline scripts 均語法通過。JSDOM 五種情境（staging/prod direct、demo、preview、無參考碼）驗證初始化後記錄、表單可用及完成仍只呼叫原關閉一次。全部網路以合成回應替代，沒有登錄或發送。
- 初次 npm test：692/694，兩項因 sandbox listen 127.0.0.1 EPERM。允許本機測試伺服器後 694/694；SQL 修正後最終全套再次 694/694 通過。npm ci 未變更 lockfile；既有依賴 audit 提示 50 項，未在本任務擅自升級。
- Reviewer 未驗證的手機、部署 CORS/schema 權限及 native 多連線併發仍列發布門檻；不得用單連線 PGlite 結果取代。沒有其他待修 Minor 項目。
