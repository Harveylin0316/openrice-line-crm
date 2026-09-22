# 訂位客回訪 Email 操作與維護

這個模組讓營運從既有「訂位成效報表」同步訂位、每週上傳餐廳優惠，先產生、檢查與修改回訪信，再由 Mac 本機透過公司信箱人工分批寄出。第一版沒有 scheduler，不會在背景自行寄信。

## 每週操作

1. 登入 CRM，從「訊息 → 訂位客回訪 Email」進入。
2. 先看頁面顯示的「訂位成效報表資料更新至」日期，再選擇訂位日期範圍；確認該批 Email 可合法用於回訪後，按「從訂位成效報表同步」。系統每次處理 500 筆並顯示進度，避免大量訂位超過 Netlify 單次 30 秒上限；同一訂位編號會更新，不會重複新增。若少數資料不在報表，才展開手動 CSV／JSON 補上。更新日期由報表站即時讀取，狀態查詢不包含客戶姓名、Email 或訂位明細。
3. 直接上傳公司 Discount Offer 後台下載的原生 `.xls`（UTF-16 HTML 表格）。CRM 會辨識原生 21 欄，並用 OR Restaurant ID 補上 OpenRice 餐廳直達 CTA，不必先另存 CSV。這份檔案視為「目前完整快照」：成功上傳至少一筆後，前一版中沒有出現的優惠會停用。畫面上的「下載原生欄位範本」會產出相同 21 欄的空白 `.xls`。
4. 設定回訪天數、同店／跨店冷卻、優惠最少剩餘天數與每日上限，選擇判斷日，按「產生本週回訪草稿」。草稿只會使用第 1 步最近完成的那一批訂位，不會把過往匯入全部混入。判斷條件是「用餐日 + 回訪天數不晚於判斷日」，不是只抓剛好第 N 天；這一步尚未寄信。
5. 打開批次，檢查排除數、收件人、餐廳、優惠、主旨、內文與 CTA。先在 Mac 本機選一封寄給自己的「正式等同測試信」。測試信會走和正式信相同的 CTA、開信追蹤、點擊追蹤與退訂路徑，但測試退訂不會修改任何客戶名單。
6. 確認無誤後，每次寄 5／10／20 封。關閉頁面或網路中斷後，狀態不明的信件會留在「寄送結果不確定」；先查公司信箱寄件備份，不能直接重寄。

## 寄送前安全門檻

- 正式寄送按鈕只有在「目前草稿版本」成功寄出測試信後才會開放，後端也會再次檢查，不能繞過畫面直接送。
- 修改任何一封草稿都會讓舊測試失效，必須重新寄測試信。測試紀錄存在 `revisit_email_test_deliveries`，不會混入正式開信／點擊數。
- 營運畫面的 `sent` 一律顯示為「公司信箱已接受」：代表 Exchange／SMTP 已接受寄送要求，不等於收件端已投遞。真正可觀測的後續行為另以開信與點擊記錄。
- 「寄送結果不確定」不再能整批重排。逐封打開後，只能選：寄件備份已有這封（標記為公司信箱已接受）、確認沒有（重新排入）、或取消；每次人工決定都記在 `revisit_email_recipient_events`。
- 後台「永遠不要再寄」名單可登錄硬退信、客訴／垃圾信申訴及人工排除。系統在產生草稿與交給公司信箱前各檢查一次。
- SMTP 在收件人階段同步回覆 5xx 時，系統會自動把該 Email 記為硬退信並停止後續寄送。EWS 的同步成功只代表 Exchange 已接受信件，兩者都無法在這一步得知稍後才出現的非同步退信或垃圾信申訴；收到 Exchange／收件匣通知後要人工加入不可寄送名單。

## 支援欄位

訂位成效報表的安全資料入口只回傳訂位編號、餐廳 ID／名稱、狀態、用餐日期、客戶姓名、Email 與來源更新時間。報表本身沒有行銷同意欄位，因此每次同步都必須由管理員確認合法使用；沒有確認就不讀取、不匯入。報表沒有公開訂位網址，因此 OR Restaurant ID 是數字時，系統會產生 OpenRice 餐廳直達頁；只有沒有可用 ID 時才退回餐廳搜尋頁。既有 CRM 自動產生的搜尋 CTA 也會在建立新草稿時更新為直達頁；人工提供的有效 CTA 不會被覆蓋。

手動檔案接受繁中或常見英文欄名，最穩定的英文範本如下。

Booking record：

```text
booking_id,restaurant_id,restaurant_name,customer_email,customer_name,dining_date,booking_status,marketing_consent,booking_url
```

- `booking_status` 可用 `completed`／`已完成`／`已到店`；取消與 no-show 不寄。
- `marketing_consent` 可用 `yes/no`、`true/false`、`1/0`、`同意/不同意`。
- 日期建議 `YYYY-MM-DD`；也接受常見日期字串與 Excel serial date。

Discount offer／套餐也保留相容舊 CSV／JSON 的欄位：

```text
offer_id,restaurant_id,restaurant_name,offer_type,offer_title,offer_description,discount_label,price_label,valid_from,valid_until,cta_url,terms,is_active
```

- `offer_type` 建議 `set_menu`、`discount` 或 `other`。
- CTA 只接受 HTTP／HTTPS。公司後台原生 `.xls` 沒有 CTA 欄位時，會依 `OR Restaurant ID` 自動產生 OpenRice 餐廳直達頁；若 ID 不是可用數字才依 `Restaurant Name(Lang1)` 產生搜尋連結。若檔案自行提供了無效 CTA，仍會退回該列。
- `offer_id` 可省略；系統會以餐廳、名稱與日期產生穩定 ID。

## Mac 本機寄件設定

複製 `.env.example` 的「訂位客回訪 Email」欄位到本機 `.env`，填入公司郵件主機與帳號。不要把真實值 commit，也不要放到 Netlify。OpenRice 目前實測可用的是 Exchange EWS／NTLM：

```text
REVISIT_EMAIL_PROVIDER=ews
REVISIT_EMAIL_EWS_URL=https://你的 Exchange/EWS/Exchange.asmx
REVISIT_EMAIL_EWS_USER=網域\\登入帳號
REVISIT_EMAIL_EWS_PASSWORD=本機密碼
REVISIT_EMAIL_EWS_FROM_EMAIL=寄件信箱
REVISIT_EMAIL_EWS_FROM_NAME=OpenRice 台灣開飯喇
REVISIT_EMAIL_EWS_REPLY_TO=回覆信箱
REVISIT_EMAIL_LOCAL_SEND_ENABLED=1
REVISIT_EMAIL_PUBLIC_BASE_URL=https://openrice-line-crm.netlify.app
```

若 Mac 上已有含 `OUTREACH_EWS_USER`／`OUTREACH_EWS_PASSWORD` 的安全 dotenv，可用 `REVISIT_EMAIL_EWS_ENV_FILE=/絕對路徑/.env` 讓本機 worker 讀取，不必複製密碼。這個路徑也只留在 Mac，不提交 Git。

EWS 寄件器使用 Mac 上的 Python 3，第一次設定時確認本機已有以下套件：

```bash
python3 -m pip install requests requests-ntlm python-dotenv
```

若另一個環境有開 SMTP AUTH，將 `REVISIT_EMAIL_PROVIDER` 改為 `smtp`，再設定 `.env.example` 內的 `SMTP_*`。未指定 provider 時，程式會優先使用設定完整的 EWS，否則使用 SMTP。

接著執行：

```bash
npm ci --include=dev
npm run dev
```

用 CRM 真正設定的登入路徑登入本機站。頁首出現「Mac 本機寄件已就緒 · Exchange EWS」後，先按「測試公司信箱連線」，再寄測試信。測試信主旨、HTML、CTA、追蹤與安全測試退訂均與正式信一致，避免「[測試]」字樣改變收件匣分類；差別只在收件地址與後台稽核紀錄。

正式站只負責同步、產生與編輯草稿，刻意不能寄信。測試與正式寄送都必須在已設定公司信箱的 Mac 執行：先在 repo 跑 `npm run dev`，再開 `http://localhost:3000/admin/revisit-email`，打開同一批草稿，依序填自己的測試 Email、檢查公司信箱連線、選一封草稿並按「③ 寄這封到測試信箱」。正式站仍會顯示這顆按鈕，但會停用並說明要回本機操作，不再把入口整個藏掉。

EWS 目前採 `SendAndSaveCopy`，每封都會保留在公司信箱的寄件備份，方便判斷結果不明的信是否真的送出。因此正式批次前要確認公司信箱仍有足夠容量；信箱接近配額上限時先清理或請 IT 擴充，不要改成不留備份來繞過。

## 程式與資料

- Route／名單與寄送：`src/routes/adminRevisitEmail.js`
- 訂位報表內部 API client：`src/core/bookingReportClient.js`
- 匯入正規化與 Email HTML／純文字：`src/core/revisitEmail.js`
- Exchange EWS：`src/core/emailProviderEws.js`
- SMTP：`src/core/emailProviderSmtp.js`
- 回訪寄件器選擇：`src/core/revisitEmailProvider.js`
- 後台：`views/admin_revisit_email.ejs`
- Schema：`supabase/migrations/20260910085055_create_revisit_email.sql`
- 寄送安全 migration：`supabase/migrations/20260911105839_revisit_email_delivery_safety.sql`
- FK 索引 migration：`supabase/migrations/20260911111039_revisit_email_fk_indexes.sql`
- 測試：`test/revisit-email-*.test.js`

信件內容在產生批次時存快照；之後更新 offer 不會改寫已產生或公司信箱已接受的歷史。每次草稿修改會增加批次內容版本，成功測試只核准當下版本。追蹤 token 是不可猜的隨機值，公開 route 只以 token 查目的地，不接受任意轉址網址。
