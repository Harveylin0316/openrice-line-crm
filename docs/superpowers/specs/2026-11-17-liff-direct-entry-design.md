# LIFF 完成後回聊天室：受控候選設計

## 已知事實與限制
- 使用者確認原始 LIFF 正常；經群發追蹤入口可完成登錄，但按「完成」後留下空白視窗，按 X 才回聊天室。
- 正式活動 HTML 的完成處理只有 `liff.closeWindow()`；尚未在可除錯的 iPhone 重現。外層瀏覽器殘留是候選根因，不是已證實的 LINE bug。
- 不改分組、獎勵、GAS、登錄或關閉按鈕。不加用戶操作。不發布 main，不修改正式環境設定，不發送訊息。

## Approaches
1. 增加中繼按鈕：增加操作且不能消除外層視窗，已撤回。
2. 直接 LIFF、放棄追蹤：不符合保留追蹤目標。
3. 直接 LIFF，登入後 POST 回 CRM 記錄已驗證的開啟：本輪實作者選用的候選。使用者已要求繼續處理；仍需手機驗收才能啟用。

## 設計
- 新增雙設定門檻：BROADCAST_DIRECT_LIFF_APPS（LIFF ID → 活動 HTTPS endpoint）及 BROADCAST_DIRECT_LIFF_ENABLED=1；預設關閉。只處理指定 app 根入口，其他連結原樣沿既有 /r/b。
- 新訊息保持 liff.line.me 入口與 g/src 等原參數，附 or_bc=批次.收件人.按鈕.版本。此參考碼不是憑證，不含 LINE ID 或 token。
- 活動 HTML 加入本機打包的輔助程式，在 LIFF 初始化且取得 ID token 後背景 POST 固定 CRM origin；不等待記錄就可操作，錯誤不影響登錄、完成。demo/preview 不傳送。
- 新 API 只收 POST：檢查允許的 Origin、LIFF ID、格式、LINE token aud/sub、原收件人、已送出狀態、實際版本及保存目的網址。交易鎖定收件人，對相同按鈕只記第一筆，並遵守既有 URL-level 唯一索引（不同按鈕同網址合併至首次歸屬），與 first_clicked_at 原子更新。GET／預覽爬蟲不記錄。
- 不新增 schema，不清理歷史爬蟲紀錄；此模式的語意是「原收件人成功初始化 LIFF」，不等於所有手指點擊。與既有 redirect GET 指標不可當成同質實驗比較。

## 發布與驗收
- 交付 staging/production HTML 候選及安裝說明；沒有工程師上傳與 iPhone 真機驗收前，sender 開關保持關閉。
- 先部署 API（設定 app allowlist）、再安裝活動端程式、最後由 Hen 核准啟用新訊息 direct 模式。關閉 sender 旗標回滾；保留 API、app allowlist 與客戶端處理既有 direct 連結。
- 舊 /r/b 連結不變，無法回改聊天室已發出的 URL；不得宣稱這能修復舊訊息。
- 需在 iOS 18.7 / LINE 26.12.1 與 Android 驗證直接入口、原收件人計數、轉傳不誤計、成功頁完成回聊天室及無多餘視窗。使用隔離資料／部署，不做真人登錄或派獎。
