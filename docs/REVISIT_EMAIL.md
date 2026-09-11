# 訂位客回訪 Email 操作與維護

這個模組讓營運每週把 booking record 與餐廳優惠上傳 CRM，先產生、檢查與修改回訪信，再由 Mac 本機透過公司信箱人工分批寄出。第一版沒有 scheduler，不會在背景自行寄信。

## 每週操作

1. 登入 CRM，從「訊息 → 訂位客回訪 Email」進入。
2. 下載 booking 範本，整理 UTF-8 CSV 或 JSON 後上傳。必填欄位：訂位編號、餐廳 ID／名稱、客戶 Email、用餐日期、狀態、行銷同意或整批合法使用確認、訂位連結。
3. 下載 offer 範本，整理本週完整有效優惠後上傳。這份檔案視為「目前完整快照」：成功上傳至少一筆後，前一版中沒有出現的優惠會停用。
4. 設定回訪天數、同店／跨店冷卻、優惠最少剩餘天數與每日上限，選擇計算日，按「產生本週回訪草稿」。這一步尚未寄信。
5. 打開批次，檢查排除數、收件人、餐廳、優惠、主旨、內文與 CTA。先在 Mac 本機選一封寄給自己的「正式等同測試信」。測試信會走和正式信相同的 CTA、開信追蹤、點擊追蹤與退訂路徑，但測試退訂不會修改任何客戶名單。
6. 確認無誤後，每次寄 5／10／20 封。關閉頁面或網路中斷後，狀態不明的信件會留在「需確認」；先查公司信箱寄件備份，不能直接重寄。

## 寄送前安全門檻

- 正式寄送按鈕只有在「目前草稿版本」成功寄出測試信後才會開放，後端也會再次檢查，不能繞過畫面直接送。
- 修改任何一封草稿都會讓舊測試失效，必須重新寄測試信。測試紀錄存在 `revisit_email_test_deliveries`，不會混入正式開信／點擊數。
- 「需確認」不再能整批重排。逐封打開後，只能選：寄件備份已有這封（標記已寄）、確認沒寄出（重新排入）、或取消；每次人工決定都記在 `revisit_email_recipient_events`。
- 後台「不可寄送名單」可登錄硬退信、客訴／垃圾信申訴及人工排除。系統在產生草稿與真正寄出前各檢查一次。
- SMTP 在收件人階段同步回覆 5xx 時，系統會自動把該 Email 記為硬退信並停止後續寄送。公司信箱已接受後才出現的非同步退信，以及垃圾信申訴，SMTP 本身不會主動回報；收到 Exchange／收件匣通知後要人工加入不可寄送名單，直到另接核准的 Graph／EWS 回報流程。

## 支援欄位

程式接受繁中或常見英文欄名，最穩定的英文範本如下。

Booking record：

```text
booking_id,restaurant_id,restaurant_name,customer_email,customer_name,dining_date,booking_status,marketing_consent,booking_url
```

- `booking_status` 可用 `completed`／`已完成`／`已到店`；取消與 no-show 不寄。
- `marketing_consent` 可用 `yes/no`、`true/false`、`1/0`、`同意/不同意`。
- 日期建議 `YYYY-MM-DD`；也接受常見日期字串與 Excel serial date。

Discount offer／套餐：

```text
offer_id,restaurant_id,restaurant_name,offer_type,offer_title,offer_description,discount_label,price_label,valid_from,valid_until,cta_url,terms,is_active
```

- `offer_type` 建議 `set_menu`、`discount` 或 `other`。
- CTA 只接受 HTTP／HTTPS。日期與 CTA 不完整的資料列會被退回並顯示原因。
- `offer_id` 可省略；系統會以餐廳、名稱與日期產生穩定 ID。

## Mac 本機寄件設定

複製 `.env.example` 的「訂位客回訪 Email」欄位到本機 `.env`，填入公司郵件主機與帳號。不要把真實值 commit，也不要放到 Netlify。

```text
SMTP_HOST=你的公司郵件主機
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=你的公司信箱
SMTP_PASSWORD=本機密碼
SMTP_FROM_EMAIL=你的公司信箱
SMTP_FROM_NAME=OpenRice 台灣開飯喇
SMTP_REPLY_TO=你的公司信箱
REVISIT_EMAIL_LOCAL_SEND_ENABLED=1
REVISIT_EMAIL_PUBLIC_BASE_URL=https://openrice-line-crm.netlify.app
```

接著執行：

```bash
npm ci --include=dev
npm run dev
```

用 CRM 真正設定的登入路徑登入本機站。頁首出現「Mac 本機寄件已就緒」後，先按「測試公司信箱連線」，再寄測試信。若公司 Exchange 環境只開 EWS 而沒有 SMTP AUTH，這個 provider 不會把 EWS 偽裝成 SMTP；需另做經 IT 核准的 EWS／Microsoft Graph provider。

## 程式與資料

- Route／名單與寄送：`src/routes/adminRevisitEmail.js`
- 匯入正規化與 Email HTML／純文字：`src/core/revisitEmail.js`
- SMTP：`src/core/emailProviderSmtp.js`
- 後台：`views/admin_revisit_email.ejs`
- Schema：`supabase/migrations/20260910085055_create_revisit_email.sql`
- 寄送安全 migration：`supabase/migrations/20260911105839_revisit_email_delivery_safety.sql`
- FK 索引 migration：`supabase/migrations/20260911111039_revisit_email_fk_indexes.sql`
- 測試：`test/revisit-email-*.test.js`

信件內容在產生批次時存快照；之後更新 offer 不會改寫已產生或已寄出的歷史。每次草稿修改會增加批次內容版本，成功測試只核准當下版本。追蹤 token 是不可猜的隨機值，公開 route 只以 token 查目的地，不接受任意轉址網址。
