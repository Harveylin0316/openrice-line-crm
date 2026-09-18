# OpenRice LINE CRM — AI 完整接手手冊

本文件讓新的 AI 或工程師不需依賴對話紀錄，即可理解產品、找到程式入口、安全修改並完成驗證。內容已更新至 2026-09-17；正式資料與部署狀態仍應在接手時重新確認。

- Repo：<https://github.com/Harveylin0316/openrice-line-crm>
- 正式站：<https://openrice-line-crm.netlify.app>
- Runtime：Node.js／Express／EJS／Netlify Functions
- 主資料庫：Supabase PostgreSQL，以 `pg` 直連
- 管理後台登入：不是固定 `/admin/login`，由 `ADMIN_LOGIN_PATH` 決定

> 開始改動前，先讀根目錄 [`AGENTS.md`](../AGENTS.md)。本文是系統地圖，不取代實際程式、測試與正式資料庫 schema。

## 1. 一分鐘理解整個應用

這是一套 OpenRice Taiwan 使用的 LINE CRM 與活動平台，不只是一個抽獎頁。它同時處理：

- LINE 官方帳號會員、好友狀態、標籤、受眾名單與第二 OA 聯絡人。
- LINE／Email 訊息建立、排程、發送紀錄與關鍵字回覆。
- 自動化流程、Rich Menu 排程與活動排程。
- 通用 LIFF 遊戲：輪盤、抽籤、刮刮樂、拉霸、直接領取。
- MGM 邀請里程、舊版春日刮刮樂、金豬食堂、訂位登錄等獨立活動。
- 洞察、成效、歸因、邀請、RFM 與每月訂位排行榜。

目前有三套容易混淆的活動領域：

| 領域 | 用途 | 主要資料 | 主要程式 |
|---|---|---|---|
| 通用活動平台 | 新活動與遊戲；「分享超有哩」屬於此處 | `activities`、`activity_prizes`、`activity_plays`、`activity_referrals` | `src/core/gamePlayEngine.js`、`src/routes/games.js`、`src/routes/adminActivities.js` |
| MGM 里程 | 依有效新好友里程碑發里數／抽獎券 | 同樣利用部分 `activity_*`，但規則獨立 | `src/core/mgmMilesEngine.js`、`src/routes/mgmMiles.js` |
| Legacy 春日活動 | 早期刮刮樂與邀請流程 | `prizes`、`draw_logs`、`line_invites`、`users.draws_left` | `src/routes/liff.js`、`src/routes/web.js` |

不要因 package 名稱仍是 `line-mgm-lucky-straw`，就把整套系統當成單一活動。

## 2. 正式環境快照

2026-09-03 確認事項：

- `https://openrice-line-crm.netlify.app/healthz` 正常。
- `https://openrice-line-crm.netlify.app/healthz/db` 正常連到資料庫。
- 「分享超有哩」正式活動頁可開啟。
- 正式環境 health 回報 Node `v24.19.0`，但 `netlify.toml` 仍指定 Node 18；後續升級依賴時要先處理這項漂移。
- 正式環境目前可看到 `GOLD_PIG_DEMO_MODE=true`；正式收款前必須確認是否仍應為 demo。
- 本基準完整測試為 56 項通過。

文件只記錄檢查當下狀態。部署、資料與環境變數可能變動，接手時應重新確認。

## 3. 系統架構與請求入口

```text
Browser / LINE LIFF / LINE Webhook / Netlify Scheduler
                         │
                         ▼
server.js → src/app.js → Express routes → core services → PostgreSQL
              │                                  │
              ├─ EJS views + public assets       ├─ LINE Messaging API
              ├─ /webhooks/line                  ├─ SureNotify / Brevo
              ├─ /webhooks/line2                 └─ Booking Report DB/API
              └─ admin / games / campaigns

Netlify: netlify/functions/server.js → serverless-http(app)
```

### 技術棧

- Node.js、Express 4、EJS、原生瀏覽器 JavaScript。
- PostgreSQL，後端以 `pg.Pool` 存取；不是前端 `supabase-js` 架構。
- JWT 存在 `httpOnly`、`sameSite=lax` cookie。
- LINE LIFF SDK、Messaging API、Webhook signature 驗證。
- Netlify Functions 與 Scheduled Functions。
- 測試使用 Node test runner；畫面測試使用 JSDOM。

### 啟動順序的重要性

`src/app.js` 會先掛 LINE webhook 的 raw body parser，再掛 `express.json()`。LINE 驗簽需要原始 bytes；調換順序會讓 webhook 全部失效。

主 PostgreSQL pool 預設最大連線數為 2，以避免 serverless 同時建立過多連線。SSL 預設開啟，只有明確設定 `PG_SSL_DISABLED=1` 才關閉。

## 4. 目錄與核心模組地圖

| 路徑 | 責任 |
|---|---|
| `server.js` | 本機／傳統 Node 入口 |
| `src/app.js` | 組裝 middleware、webhook、後台與所有活動 routes |
| `netlify/functions/server.js` | Netlify Functions 包裝入口 |
| `netlify/functions/run-*.js` | 排程觸發器，呼叫站內受 secret 保護的 runner |
| `src/core/gamePlayEngine.js` | 通用遊戲配額、抽獎交易、庫存、coupon、邀請加碼的唯一核心 |
| `src/core/mgmMilesEngine.js` | MGM 里程碑、迎新里程、抽獎券邏輯 |
| `src/core/dbInit.js` | 早期／部分 schema 初始化；不是完整 migration source of truth |
| `src/routes/adminActivities.js` | 通用活動與獎品的後台 CRUD、預覽與排程 |
| `src/routes/games.js` | 通用遊戲頁面與 API 註冊 |
| `src/routes/mgmMiles.js` | MGM 前台與後台流程 |
| `src/routes/liff.js` | Legacy 春日 LIFF 遊戲與邀請 |
| `src/routes/web.js` | Legacy web 路由 |
| `src/routes/adminBroadcast.js` | LINE／Email 群發、排程、歷史 |
| `src/routes/adminRevisitEmail.js` | Booking record 回訪名單、草稿、人工寄送與追蹤 |
| `src/core/revisitEmail.js` | 訂位／優惠正規化與回訪信模板 |
| `src/core/emailProviderSmtp.js` | 僅供 Mac 本機使用的公司 SMTP 寄件器 |
| `src/routes/adminFlows.js` | 自動化流程編輯與執行 |
| `src/routes/adminRichMenu.js` | Rich Menu 管理、點擊追蹤與排程 |
| `src/routes/adminUsers.js` | 會員、標籤規則與受眾操作 |
| `src/routes/lineWebhook.js` | 主 LINE OA webhook |
| `src/routes/line2Webhook.js` | 第二 OA webhook，資料應與主 OA 隔離 |
| `views/` | EJS 頁面；部分頁面含大量 inline CSS／JS |
| `public/` | 靜態圖片、樣式、前端 script 與公開推播媒體 |
| `test/` | 單元、route、JSDOM 與回歸測試 |
| `supabase/migrations/` | 目前只有部分 Gold Pig migration，並非完整 schema |

找功能時，建議依序追：route → core/service → SQL/table → view → test。不要直接在 view 複製後端規則。

## 5. 管理後台功能地圖

`views/layout.ejs` 的導覽是目前最完整的功能索引。

### 訊息與自動化

- 群發建立、排程與歷史：`/admin/broadcast`、`/admin/broadcast/history`
- 訊息素材：`/admin/messages`
- 關鍵字回覆：`/admin/keyword-replies`
- 自動化流程：`/admin/flows`
- Rich Menu：`/admin/richmenu`
- 訂位客回訪 Email：`/admin/revisit-email`

#### 訂位客回訪 Email（2026-09-10）

這是獨立於 LINE／SureNotify 群發的人工回訪工作台。第一版**沒有排程自動寄送**：

1. 每週上傳 UTF-8 CSV／JSON booking record；再上傳當期 discount offer／套餐。
2. 系統只取每位客人在各餐廳最近一次已完成、可做 Email 行銷的訂位，依「用餐後天數」、同店／跨店冷卻、退訂與是否已寄過排除。
3. 以餐廳 ID 配對優惠；套餐優先於折扣，優惠必須仍在有效期且至少剩設定天數。沒有優惠時，booking record 必須提供餐廳訂位網址，才會產生一般回訪信。
4. 管理員先逐封查看／修改主旨、預覽文字、內文與 CTA，寄「正式等同測試信」後，再按批次手動寄出；每次最多 20 封、每日上限可設定。正式寄送 API 會核對批次 `content_version` 與 `tested_version`，任何草稿修改都會使舊測試失效。
5. 正式信記錄已寄、第一次開信、第一次點擊與退訂。開信率受郵件客戶端圖片代理／封鎖影響，只能當方向性指標。

寄件安全邊界：

- Netlify production 一律不能從公司信箱寄送。只有非 production 的 Mac process 同時設定 `REVISIT_EMAIL_LOCAL_SEND_ENABLED=1`，以及完整 EWS 或 SMTP 連線，才會顯示測試／正式寄送。OpenRice 現行公司 Exchange 實測走 EWS／NTLM；`REVISIT_EMAIL_PROVIDER=ews`，帳密僅留在 Mac。
- 帳號密碼只放 Mac 本機 `.env`，不得放 Netlify、Git、文件、fixture 或 log。正式站仍負責公開 HTTPS 開信、點擊與退訂網址。
- 公司郵件服務接受後若 DB 回寫失敗，信件標為「需確認」；不得自動重寄。先到公司寄件備份確認未寄出，再由管理員手動重新排入。EWS 採 `SendAndSaveCopy`，正式寄送前需確認信箱未接近容量上限。
- 「需確認」只能逐封標記已寄、確認未寄後重排、或取消，所有決定寫入 `revisit_email_recipient_events`；舊的整批重排端點固定回 410。
- 測試信使用和正式信相同的主旨、CTA、開信／點擊追蹤與安全測試退訂路徑；測試 token 存在 `revisit_email_test_deliveries`，點測試退訂不會修改客戶退訂名單，也不混入正式成效。不要在主旨強加「[測試]」，否則無法驗證真實收件匣分類。
- `revisit_email_suppressions` 保存硬退信、客訴與人工排除。名單產生和 SMTP 寄送前都會查；收件人階段同步 5xx 會自動加入硬退信。SMTP 接受後的非同步退信／申訴仍需人工登錄，直到另接獲核准的 Graph／EWS 回報來源。
- 每批寄送前會重查全域退訂與同一訂位是否已寄，並以交易、列鎖、每日上限與每次 20 封限制降低誤寄／重寄風險。
- booking consent 欄位有明確 `no` 時不會被匯入頁的整批確認覆蓋；無法辨識的非空值也一律視為未同意。

資料表：`revisit_email_settings`、`revisit_email_imports`、`revisit_email_bookings`、
`revisit_email_offers`、`revisit_email_campaigns`、`revisit_email_recipients`、
`revisit_email_test_deliveries`、`revisit_email_recipient_events`、`revisit_email_suppressions`。Migration：
`supabase/migrations/20260910085055_create_revisit_email.sql`、
`supabase/migrations/20260911105839_revisit_email_delivery_safety.sql`、
`supabase/migrations/20260911111039_revisit_email_fk_indexes.sql`。所有表啟用 RLS，撤銷
`anon`／`authenticated`，客戶 Email 與信件快照不得由 Supabase Data API 公開。

本機實際寄送操作與欄位格式見 [`REVISIT_EMAIL.md`](./REVISIT_EMAIL.md)。

#### 直接貼 LINE User ID 推播（2026-09-08）

`/admin/broadcast` 的收件人頁籤有「貼 LINE User ID」：可貼一行一個 ID，或直接貼
CSV，再預覽人數、編輯文字／圖片／影片／Flex 卡片，最後立即或排程發送。直接推播
不要求 ID 已存在 `users`，也不必先建立已儲存名單；若日後要重複使用，可在同一區展開
「另外存進名單庫」。

後端只接受 `U + 32 個十六進位字元`，會去重並限制每批最多 5,000 人。已知已封鎖或
封存舊 OA 的會員在預覽與建立批次時排除；CRM 未知的格式合法 ID 仍交給 LINE API
判斷，若屬於其他 Provider、封鎖 OA 或無法接收，逐筆結果會記在群發紀錄。正式批次
仍沿用訊息預檢、測試訊息、二次確認、分批發送、取消及歷史紀錄等既有防線。

主要程式入口：`src/core/broadcastAudience.js` 的 `lineUserIds` 受眾、
`src/routes/adminBroadcast.js` 的預覽／建立批次、`views/admin_broadcast.ejs` 與
`public/admin-broadcast.js`。

#### 精確控制本次發送人數（2026-09-17）

`/admin/broadcast` 的所有受眾來源（條件篩選、已儲存名單、直接貼 LINE User ID，以及
Email 已儲存名單）都可選「全部符合條件的人」或「隨機抽指定人數」。例如完整符合者有
2,000 人，輸入 423 後，預覽會同時顯示「符合 2,000 人／本次隨機發送 423 人」。單批仍
最多 5,000 人；指定值不是 1–5,000 整數，或大於目前符合人數時，後端整批拒絕，不會
自動改成較少人或全部發送。

前端預覽數字不是安全依據。建立批次時 route 會重新計算完整母體，再用 PostgreSQL
`ORDER BY RANDOM()` 取精確人數；查回筆數若與指定值不同，代表期間名單已變動，批次不會
建立，管理員必須重新預覽。成功建立後，抽中的人會立即物化進
`admin_broadcast_recipients`，因此立即發送、排程及 Campaign Testing 都使用同一份凍結
名單，不會中途換人。抽樣設定與當時完整符合人數存入既有
`admin_broadcasts.audience_config.recipientSelection`，不需要 schema migration。

核心檢核與取樣在 `src/core/broadcastAudience.js`，API 防線在
`src/routes/adminBroadcast.js`，前端控制在 `views/admin_broadcast.ejs`／
`public/admin-broadcast.js`，回歸測試在 `test/broadcast-recipient-selection.test.js`。

#### Campaign Testing／A/B/C 小樣本測試（2026-09-17）

`/admin/broadcast` 的 A/B 進階區可再啟用 Campaign Testing。管理員可選 A/B 或 A/B/C、
自訂各測試版與 Winner 保留名單比例（例如 10%／10%／80%）、設定 1–168 小時觀察期，
並分別編輯與測試各版文字、Hero 圖及 CTA。所有測試版同時送出，避免發送時間成為干擾；
第一版只以 CTR（不重複 CTA 點擊者 ÷ 成功送達）自動選 Winner。Booking Conversion 選項
在 LINE 身分與訂位紀錄有可信串接前保持停用，不得以猜測資料選 Winner。

建立批次時會一次抓取受眾、隨機分組並物化到 `admin_broadcast_recipients`。測試組狀態為
`pending`，保留名單為 `waiting_winner`；後續不重算受眾，所以各組互斥且不會重複發送。
測試組全部送完後才寫入 `observationStartedAt`／`winnerAt` 並進入 `awaiting_winner`；排程或
手動 chunk 重試不會把截止時間往後延。排程 runner 到達 `winnerAt` 後依 CTR 建立一個
一般 LINE 勝出版批次，將原保留名單標為 `released`，母批次改為 `winner_released`。
釋放時會鎖定母批次，cron 與管理員手動按鈕同時操作也只會成功一次；若所有測試版皆無
成功送達，不會自動發送保留名單。管理員也能在母批次詳情手動指定版本，或取消保留名單。

實驗設定與 C 版內容儲存在既有 `admin_broadcasts.audience_config.experiment` JSONB，沒有新增
公開資料表。CTR 依帶 `recipient_id` 的追蹤網址計算，因此 Campaign Testing 限用一般訊息
編輯器；進階 Flex JSON 的任意按鈕尚不能保證都經過 CTR 追蹤。Flex 仍可編輯及預覽，
但畫面會立即顯示原因並鎖住正式送出，不會等到最後一步才用不明確錯誤拒絕。核心純邏輯在
`src/core/campaignExperiment.js`，route／runner 在 `src/routes/adminBroadcast.js`，回歸測試在
`test/campaign-experiment.test.js`。

#### Flex 卡片 CTA 網址編輯（2026-09-18）

訊息庫與群發編輯器的進階 Flex 模式會走訪卡片內所有 `action.type="uri"`，在「按鈕連結
（CTA URL）」直接列出按鈕名稱與目前網址；已經是正式網址的按鈕也要顯示，不能只顯示
`REPLACE_*` 佔位符。A／B／C 各版有自己的欄位，套用時依 JSON path 只改指定按鈕，避免
兩顆共用舊網址時被一起誤改。訊息庫模式不得載入或改寫群發草稿，也不得因上次群發開過
A/B/C 而出現多版本預覽。歷史素材可能只有帶底色、圓角與置中文字的「按鈕外觀」，但沒有
LINE `action`；編輯器也會把這種區塊列成「尚未設定」，填入 URL 後自動建立
`action: { type: "uri", label, uri }`，否則用戶雖看得到按鈕卻無法點擊。前端與回歸測試在 `public/admin-broadcast.js`、
`views/admin_broadcast.ejs`、`test/broadcast-preview-ui.test.js`。

#### 群發加入好友日期篩選（2026-09-11）

`/admin/broadcast` 的「條件篩選」除了最近 1／7／30／90 天，也可選「自訂日期範圍」。
開始日或結束日可單獨使用；兩者都填時是包含首尾日期的閉區間，並以 `Asia/Taipei`
曆日換算 `users.created_at`。預覽人數與建立正式批次共用
`src/core/broadcastAudience.js` 的正規化、日期檢核與 SQL，避免預覽／實際發送名單不一致。
既有 `joinedWithinDays` 批次維持相容；自訂日期存在時優先使用 `joinedFromDate`／
`joinedToDate`，不會與殘留的快捷天數意外交集。

同一區也有「活動參與（可包含或排除）」：先選「包含玩過的人／排除玩過的人」，再選
「任一活動」或一個指定活動。資料口徑是 `activity_plays.line_user_id` 的實際遊玩紀錄；
只開活動頁但沒有開始玩仍算未參加。指定活動後可組出「排除玩過分享超有哩的人」；
選任一活動搭配排除，則只保留完全沒有玩過任何 CRM 活動的人。舊批次只有 `any`／`none`
而沒有活動 ID 時維持原本語意。活動參與與加入時間、生命週期、獎品等其他已選條件使用
**AND**；例如「7 天內加入」加「排除玩過的人／分享超有哩」只會選中兩者同時成立的人。
頁面另有「一鍵套用這個範例」，會先清空其他條件再套用「近 7 天且未玩過任何活動」，
避免殘留條件造成名單過少。預覽與正式發送共用 `src/core/broadcastAudience.js` 的參數化
`EXISTS`／`NOT EXISTS` SQL；不存在的活動 ID 有額外存在性防線，只會得到空名單，不會
因排除條件意外選中全部會員。正式環境已有 `activity_plays(line_user_id)` 索引，不需額外 migration。

#### 圖文選單點擊後延遲推播（2026-09-07）

後台已可建立「點了圖文選單」流程：

1. 先到 `/admin/messages` 建立要發送的內容。除了單一卡片與進階 Flex，也可用「新增文字／圖片／影片組合」把最多 5 段內容排成同一次 LINE 推播；圖片可上傳，影片需提供公開 HTTPS MP4 與預覽圖。
2. 到 `/admin/flows` 新增流程，觸發條件選「點了圖文選單」，再選已發布選單與「任一功能按鈕」或指定按鈕。
3. 步驟通常依序放「等待」與「發訊息」。排程每分鐘推進，實際送出會有約一分鐘內的排程誤差。
4. 啟用前用「安全試跑／發給自己」確認訊息。正式啟用後可從流程列表查看進行中、累計、漏發與卡住人數。

行為與安全邊界：

- 只計算會開啟網址或送出文字的功能按鈕；Rich Menu 分頁切換不算。
- 流程編輯器可設定「同一人最多觸發幾次」，並選擇整段流程期間、每天、滾動 7 天或滾動 30 天。設定存在 `trigger_config.user_limit`，由 `flowEngine.enrollUser()` 在所有真正新增 enrollment 前統一檢查；未發送前的圖文選單連點只重設倒數，不多扣次數。
- 舊流程未儲存 `user_limit` 時完全沿用原本 `re_enroll` 行為；編輯器會把舊的「不可重入」顯示成整段期間 1 次，把「可重入」顯示成不限次數。沉睡喚醒固定每人一生一次，避免仍在沉睡的用戶每分鐘被重複加入。
- 同一用戶在訊息尚未送出前重複點擊，不會堆疊多份推播，而是以最後一次點擊重新倒數。訊息已送出後不會因連點重播。
- 21:00–08:00 是安靜時段。延遲到安靜時段的訊息會順延至 08:00 後，不會半夜發送。
- 網址按鈕透過 LIFF ID token 向 LINE 驗證身分；後端不接受前端自行宣告的 LINE user ID。驗證或紀錄失敗不能阻擋按鈕原本的跳轉。
- 2026-09-07 以前發布的選單，若流程編輯器顯示舊版追蹤警告，必須回 `/admin/richmenu` 重新發布一次。這會把所有 HTTPS 網址按鈕換成安全追蹤跳板；原始目的地仍保存在 `rich_menus.published_config`。
- 2026-09-07 已將現役預設選單（DB menu `id=3`，兩分頁）以 LINE 原圖重新發布：前後圖片雜湊一致，8 個 URI 均已接上跳板，4 個 message action 與 2 個分頁切換均保留。備用單頁選單 `id=2` 仍是舊模式；未來若要切它上線，先重新發布一次。

主要程式入口：`src/core/flowEngine.js` 的 `triggerRichMenuTap()`／`enrollUser(...restartActive)`、`src/routes/adminRichMenu.js` 的 `/t/...` 跳板、`src/routes/lineWebhook.js` 的 message action 比對、`src/core/broadcastTemplates.js` 的 `mode='sequence'`，以及 `views/admin_flows.ejs`、`views/admin_message_sequence.ejs`。

#### 跨圖文選單／推播／歡迎訊息的活動開啟觸發（2026-09-07）

同一活動可能從圖文選單、群發卡片、LINE 官方歡迎訊息或外部貼文進入。若只用
`rich_menu_tap` 或 `broadcast_click`，其他入口不會觸發。這類需求應在 `/admin/flows`
選「開啟指定活動（跨入口）」：

1. 選 CRM 內建活動，或填外部活動名稱及 HTTPS 網址。
2. 設定等待、發訊息／加入名單等步驟與「同一人最多觸發幾次」。
3. 第一次儲存後，編輯器會產生圖文選單、推播、歡迎訊息與其他入口四條 LIFF 網址；
   把每條網址貼到相應渠道的 CTA。來源人次會顯示在同一設定區。

CRM 內建活動另有 fallback：遊戲頁的 `/meta` 完成 LINE ID token 驗證後，會依
`activity_id` 呼叫 `triggerCampaignOpenByActivity()`。因此「分享超有哩」即使舊推播或
歡迎訊息仍貼原始活動網址，也能觸發；fallback 以 `direct` 記錄，而且不會覆蓋剛由
追蹤入口記下的 `richmenu`／`broadcast`／`welcome` 來源。`preview=1` 絕不觸發。

外部活動（例如「中秋開飯驚喜」在 `tw.openrice.com`）無法由 CRM 直接知道誰開啟，
所以每個渠道必須改用編輯器產生的對應 LIFF 網址。跳板用 LINE 驗證後的 token `sub`
辨識身分，將點擊寫入既有 `message_taps`，再呼叫綁定的 `campaign_open` flow；流程暫停
時已發出的網址仍會把用戶送到活動，追蹤失敗也不會卡住。刪除流程會失去目的地設定，
因此曾對外使用過的活動流程應改為「暫停」，不要刪除。沒有新增資料表，
來源保存在 `admin_flow_enrollments.context.source`。

主要程式入口：`src/routes/adminFlows.js` 的 `/ce/:flowId/:source` 跳板、
`src/core/flowEngine.js` 的 `triggerCampaignOpen()`／`triggerCampaignOpenByActivity()`、
`src/routes/gamesGeneric.js` 的已驗證 meta fallback，以及 `views/admin_flows.ejs`。

### 數據與歸因

- 洞察／報告：`/admin/insight`、`/admin/reports`
- 歸因與邀請：`/admin/attribution`、`/admin/referrals`
- 通用 LIFF 來源追蹤：`/admin/liff-tracking`
- LIFF／Random Rice：`/admin/liff/random-rice`
- RFM：`/admin/rfm`

期間控制：`/admin/insight` 可選 7／30／90／180／365 天，也可直接選開始日與結束日；
最多 397 天、包含首尾，所有 CRM 圖表與表格使用同一組 `Asia/Taipei` 曆日。網址會保留
`from`／`to`，重新整理仍是同一區間；舊的 `?days=` API 仍相容。Random Rice 行為分析
仍可選快捷期間或自行輸入 1–365 天。`/admin/attribution` 的「點擊後觀察期」可選到
90 天或自行輸入 1–365 天。LINE 官方好友總數、輪廓與昨日訊息量是最新快照，不會因
站內期間篩選而改變；畫面有明確註記。RFM 的「30 天內算活躍」是分群規則，不是報表
篩選，不能跟著改。

`/admin/insight` 的圖文選單區同時呈現兩種不同口徑：

- 「LINE 官方曝光次數／曝光人數」呼叫 rich menu insight summary API；依 CRM 目前仍保留
  在 LINE 上的 published rich-menu ID 逐分頁查詢，總曝光只加總 `impression.metrics.count`。
  各分頁的 `uniqueUsers` 不可跨分頁相加，畫面也不顯示誤導性的總曝光人數。
- 「CRM 記名點擊」來自 `rich_menu_taps`，可辨識點擊者並供自動化使用，不能拿來假裝曝光。
- LINE 曝光以官方 UTC+9 曆日統計且通常隔天完成；查詢含今天時，曝光最多只查到 LINE
  已可結算的昨天，CRM 其他資料仍照使用者選的完整區間。
- 若期間內點擊的不重複用戶少於 20，LINE 會因隱私只回 rich-menu ID，不回曝光；畫面顯示
  「隱私門檻未達」，不可顯示 0。summary 回 404 時會再查選單本體：本體仍存在就顯示
  「待更新」，只有本體也 404 才標「已刪除」。已從 LINE 刪除的舊選單版本無法
  回溯官方曝光。
- 官方端點限制 60 requests/hour。後端同一選單頁與日期區間快取 15 分鐘，單次最多查前
  12 個選單頁；任何 LINE 失敗都不得拖垮整頁 CRM 統計。

#### 通用 LIFF 來源追蹤（2026-09-09）

`/admin/liff-tracking` 用來替任何 LIFF／HTTPS 活動建立來源專屬網址，不必建立自動化流程。
管理員填追蹤名稱、Campaign、來源、目的地，並可選「完成一次指定活動遊玩」或既有
`user_events.event_name` 作為轉換。來源／Campaign 建立後固定；要換意義就新增另一條，
避免歷史數據被改名。網址可暫停追蹤，但仍會把使用者送到原目的地。

公開網址為 `https://liff.line.me/{GAMES_LIFF_ID}/lt/{id}`，實際會進
`/games/lt/:id`，由 `tap_bounce` 取得 LINE ID token，再 POST `/lt/:id/hit`。後端只接受
LINE 驗證後的 `sub`，同一人同一網址同一分鐘以 DB unique constraint 去重；安全性或
資料庫失敗都不能阻擋原本跳轉。頁面報表提供 7／30／90／180／365 天與全部期間，包含
開啟次數、不重複用戶、每日趨勢、來源比較、轉換與轉換率。轉換觀察期由每條網址設定，
以該人第一次開啟為起點。

資料表為 `liff_tracking_links`、`liff_tracking_events`；兩表啟用 RLS 並撤銷
`anon`／`authenticated` 權限，僅由後端 PostgreSQL 連線存取。Migration：
`supabase/migrations/20260909094059_liff_source_tracking.sql`。主要程式：
`src/routes/adminLiffTracking.js`、`views/admin_liff_tracking.ejs`。不要把追蹤網址直接做成
任意 `?target=` 轉址；目的地必須回 DB 查，否則會形成公開 open redirect。

### 會員與名單

- 會員：`/admin/users`
- 標籤規則：`/admin/tag-rules`
- 受眾名單：`/admin/recipient-lists`
- 第二 OA 聯絡人：`/admin/oa-contacts`
- 餐廳：`/admin/restaurants`

### 活動

- 通用活動：`/admin/activities`
- MGM：`/admin/mgm`
- 優惠券：`/admin/coupons`
- 訂位登錄、春日活動、Ludian：對應 `/admin/booking-reg`、`/admin/spring`、`/admin/ludian`

### 設定

- 管理員帳號：`/admin/accounts`
- 個人帳號／密碼：`/admin/account/password`
- Email 網域：`/admin/email-domain`

## 6. 通用活動與遊戲平台

### 遊戲型別與 URL

通用遊戲以 activity 的 `game_type` 與 `slug` 驅動，目前支援：

- `wheel`：輪盤
- `fortune`：抽籤
- `scratch`：刮刮樂
- `slot`：拉霸
- `claim`：直接領取

典型前台 URL 是 `/games/{game_type}/{slug}`。每種遊戲透過 register game type 的方式共用頁面、活動資訊、遊玩、邀請與配額 API；wheel 另保留 `/spin` 相容入口。

### 一次遊玩的後端流程

`src/core/gamePlayEngine.js` 是規則中心。高階流程如下：

1. 驗證活動存在、時間與狀態。
2. 驗證 LIFF access token，並以 token 的 `sub` 決定 LINE user ID。
3. 視活動設定確認已加入 OA。
4. 開啟 DB transaction，使用 `play_key` 防止重送造成重複抽獎。
5. 鎖定相關使用者／獎品資料，計算剩餘次數。
6. 依權重選獎，並在併發鎖定後重新確認庫存。
7. 若為 coupon，使用 `FOR UPDATE SKIP LOCKED` 領取未用兌換碼。
8. 扣庫存並寫入 `activity_plays` 的當下獎項快照。
9. commit 後回傳結果，前端只負責動畫與呈現。

不能把抽獎決定移到前端，也不能因視覺動畫另外再抽一次。

### 次數公式

畫面與實際抽獎都必須呼叫 `computeUserQuota()`／`computeQuotaNumbers()`：

```text
可用總次數 = 基礎次數 + 有效新好友加碼 + 人工加碼
剩餘次數 = max(可用總次數 - 已玩次數, 0)
```

好友加碼受活動設定的「每幾位好友換一次」與「最多加幾次」限制。人工加碼存在 `activity_bonus_plays`，不要直接改已玩次數。

### 邀請判定

- 被邀請者原本已經是 LINE OA 好友：仍可使用自己的基礎遊玩次數。
- 只有 `invitee_was_existing IS FALSE` 的有效新好友，才計入邀請人的加碼。
- 新好友通常會先得到 `invitee_not_follower`，這筆 pending 必須先落庫，才能讓使用者開始加好友。
- LINE 發出已驗簽的 follow webhook 時，`src/core/activityReferralFollow.js` 會在同一個 webhook request 內直接完成 pending referral；使用者不需要返回頁面，也不需要按「我加好了」。
- 前端的自動重查與異常情況才顯示的「重新確認」，只是 webhook 或 LINE 同步延遲時的備援，不是正常入帳步驟。
- `invitee_was_existing` 必須依第一次邀請嘗試前的狀態判定，不能因 follow webhook 已建立 `users` 就誤標成既有好友。
- pending referral 有效期 72 小時；同活動多個邀請連結採 last touch；短暫 DB 異常會在 webhook 內重試。
- 新／舊好友判定結果是 `null` 時絕對不能寫入 `activity_referrals`，否則 unique key 會把「無法判定」的結果永久占位，後續無法補發。
- 重複 callback／referral 不得重複發獎；相關 unique constraint 與冪等不能移除。

### 活動排程

活動狀態會由排程 runner 依開始／結束時間更新。管理員修改時間或狀態時，要同時考慮 runner 下一次執行會不會覆寫人工操作。

## 7. 「分享超有哩」活動

這個活動是通用輪盤，不是 MGM route：

- 活動 ID：`6`
- game type／slug：`wheel/share-miles`
- 後台：`/admin/activities/6`
- 前台：`/games/wheel/share-miles`
- 主要畫面：`views/game_wheel.ejs`
- 編輯頁：`views/admin_activity_edit.ejs`
- 成效與得獎管理：`/admin/mgm?activity_id=6`

### 正式規則基準

- 每位符合資格的使用者至少可玩 1 次。
- 每成功邀請 1 位原本不是 OA 好友的人，再加 1 次。
- 好友邀請最多加 3 次，因此未含人工補次時最多可玩 4 次。
- 原本已是好友的人可以玩自己的首次機會，但不替邀請人增加次數。
- 抽到的獎項直接留在抽獎頁「我的獎項」，不要求使用者再點另一個頁面查看。
- 邀請好友使用 LINE Flex Message 卡片：封面圖、標題與說明讀 activity 資料，「馬上玩」CTA 必須保留 `?ref=<inviter LINE user ID>`。
- Flex 無法送出時會退回文字連結；分享成功本身不加次數，仍要等新好友透過連結加入 OA。

上述數字仍應從 activity rules 讀取，不能在 view 寫死。

### 成效、庫存與得獎名單

`/admin/mgm` 雖保留早期 MGM 命名，但現在是所有通用活動的成效頁。切到「分享超有哩」後，同頁可查看參與／遊玩／邀請 KPI、逐筆邀請、邀請人排行、每個獎項的總量／已抽出／剩餘、依得獎者彙總的待發名單，以及逐筆中獎紀錄與 CSV。

活動成效可選全部期間、近 7／30／90／180／365 天，或自訂最多 366 天的起訖日期；
日期以 `Asia/Taipei` 的 00:00 日界線計算。同一篩選會套到 KPI、邀請關係、邀請排行、
遊玩、得獎彙總、逐筆中獎、CSV 與從報表建立的名單。獎品卡的「目前剩餘」永遠是即時
庫存，只有抽出數依期間變化。個人次數除錯固定查看完整活動紀錄，抽大獎也固定使用完整
活動母體，兩者不可受報表日期影響。

里數存於新版快照的 `prize_snapshot.prize_value.miles`；早期資料可能在 `prize_snapshot.miles`，報表查詢必須同時相容兩種格式。得獎者彙總不可在 grouped query 裡以未分組的 outer `activity_id` 做 correlated subquery；2026-09-04 曾因此讓整頁回 `data_failed`。標記已發須依非 `none` 的 play ID 更新，不能只檢查舊版頂層 `miles` 欄位，否則新版里數、Rice Dollar 與優惠券都不會被標記。

### 可設定的 UI

設定主要存於 `activities.rules.ui`，目前包含：

- `show_hero_art`：是否顯示標題右上插圖。
- `logo_url`：頁首 Logo。
- `wheel_style`／`wheel_custom`：輪盤風格、尺寸、邊框、指針、中心等。
- `wheel_slice_colors`：各獎項扇形可獨立選色，不再只共用三色。
- `copy`：提示語與畫面文案。

輪盤中心預設圖是 `public/images/rice-dollar-wheel-hub.png`。大獎 fallback 視覺是 `public/images/share-miles-grand-prize-v1.webp`。

### 安全預覽

後台可選不同使用者狀態與強制獎項預覽。`preview=1` 必須維持純前端展示：

- 不扣次數。
- 不扣庫存。
- 不新增中獎紀錄。
- 不需要真實 LINE 好友。
- 不呼叫 spin、quota、wallet、referral 等正式 API。

### 獎項狀態文案

「我的獎項」的尚未發放／已發放文案已放到同一個活動編輯頁，儲存於 `rules.ui.copy`，並由 `views/game_wheel.ejs` 顯示。新版不應再寫回固定字串。

## 8. 資料庫與資料模型

### 最重要的現況

repo 目前**沒有完整可重建正式資料庫的 migration 歷史**：

- `supabase/migrations/` 只包含部分 Gold Pig migration。
- `src/core/dbInit.js` 只涵蓋早期與部分 schema，不是完整正式 schema。
- 正式環境預設不執行 DDL；只有 `RUN_DB_DDL_ON_BOOT=1` 才會跑 legacy init。

因此要建立新環境、災難復原或修改 schema 時，必須先從 Supabase migration history／正式 schema 匯出確認。不要假設 `npm start` 能建立完整資料庫。

### 主要資料群組

| 群組 | 代表資料表 | 說明 |
|---|---|---|
| 通用活動 | `activities`、`activity_prizes`、`activity_plays` | 活動規則、獎品、遊玩與獎項快照 |
| 邀請與配額 | `activity_referrals`、`activity_referral_attempts`、`activity_user_quotas`、`activity_bonus_plays` | 邀請狀態、有效新好友、人工補次 |
| 優惠券 | `coupon_codes` | 可領取 code、鎖定與核銷狀態 |
| Legacy 活動 | `users`、`prizes`、`draw_logs`、`line_invites`、`campaign_settings` | 早期春日刮刮樂，不與通用活動混寫 |
| 訊息 CRM | broadcast、messages、flows、keywords、delivery events 類表 | 群發、自動化與成效 |
| 訂位回訪 Email | `revisit_email_*` 六張表 | 每週來源、優惠、草稿、寄送與開信／點擊／退訂 |
| 第二 OA | `oa_contacts` 等 | 第二官方帳號資料，避免與主 OA 混用 |
| 金豬食堂 | Gold Pig migrations 所建表 | 訂位與活動資料 |

`activity_plays` 應保存中獎當下的名稱、圖片、說明等快照，避免後台日後改獎品名稱，歷史紀錄也跟著改變。

### Schema 修改規則

- 先建立 migration，再改程式；禁止只在 runtime 偷做 `ALTER TABLE`。
- 驗證 unique constraints、foreign keys、索引與 transaction 競態。
- Supabase 若開放 Data API，必須一併檢查 RLS；後端直連成功不代表 Data API 安全。
- Production 維持 `RUN_DB_DDL_ON_BOOT` 未設定。
- 修改 JSON rules 時保留未知欄位，避免舊版／新版部署互相刪設定。

## 9. 外部整合

### LINE 主 OA 與第二 OA

- 主 OA 使用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`，入口 `/webhooks/line`。
- 第二 OA 使用 `LINE2_CHANNEL_SECRET`、`LINE2_CHANNEL_ACCESS_TOKEN`、`LINE2_OA_KEY`，入口 `/webhooks/line2`。
- 兩者都要驗證 signature，且不可共用錯誤的 contact／tag 資料。
- LINE Push 圖片必須是 LINE 伺服器可抓到的公開 HTTPS URL。

### LIFF

- Legacy 活動使用 `LIFF_ID`。
- 通用遊戲可用 `GAMES_LIFF_ID`，輪盤可用 `WHEEL_LIFF_ID` 覆蓋。
- 正式遊玩應啟用 token 驗證；不要信任 query string 或 request body 自稱的 LINE user ID。
- `LIFF_ENDPOINT_IS_SITE_ROOT` 會影響產生永久連結時是否補 `/liff`，設定錯會出現重複路徑。

### Email

- 支援 SureNotify 與 Brevo，依 `EMAIL_PROVIDER` 選擇。
- 訂位客回訪另用 Mac 本機 `SMTP_*`，與 `EMAIL_PROVIDER` 無關；開啟回訪功能不會改變既有一般 Email 群發 provider。
- 寄件網域、API key、webhook 驗證都屬 server-side secret。
- 訊息顯示已送出不等於到達；成效需看 provider event／delivery log。

### Booking Report

每月訂位排行榜使用第二個 PostgreSQL pool，連到 `BOOKING_REPORT_DATABASE_URL`。這不是主 CRM DB；修改查詢前要理解 booking-report schema，並維持小 pool 與短 timeout。

### 金豬食堂

使用獨立 `GOLD_PIG_LIFF_ID` 與訂位 API key。`GOLD_PIG_DEMO_MODE=1` 時不代表真實訂位成功；正式收款／訂位上線前需關閉 demo 並做端到端驗證。

LINE 內建指令目前只保留「查詢訂位／查看訂位」。`取消訂位` 不再由
`src/core/goldPigBookings.js` 攔截或寫入取消申請；若日後需要自動回覆，應在後台
「關鍵字回覆」建立可看見、可停用的規則，不能再把營運文案藏進程式。

## 10. 登入、權限與安全邊界

- 後台 JWT cookie 有效期 7 天，設為 `httpOnly`、`sameSite=lax`。
- `staff`：一般日常管理。
- `admin`：owner-only 高風險操作，例如帳號管理、部分破壞性活動操作與 MGM 抽獎。
- 真正登入網址由 `ADMIN_LOGIN_PATH` 設定；固定 `/admin/login` 故意回 404。
- 每個後台 request 會檢查帳號 liveness。DB 故障時 GET 可提供有限唯讀降級，但 POST／PUT／DELETE 必須禁止。
- 登入有 route rate limit 與 DB／IP 節流，修改時要保留雙層防護。
- 未觀察到全站一致的顯式 CSRF token 層。若未來讓後台跨網域、開放更多使用者或更改 cookie 策略，應做完整威脅模型與 CSRF 評估。
- 所有 log、fixture、文件都不得包含真實 LINE user ID、Email、電話、access token 或資料庫密碼。

## 11. 環境變數索引

實際範例見 [`.env.example`](../.env.example)。以下按責任分類，值應存於 Netlify／本機 secret 管理，不得 commit。

| 類別 | 主要變數 |
|---|---|
| 核心 | `DATABASE_URL`、`JWT_SECRET`、`NODE_ENV`、`PORT` |
| DB pool | `PG_POOL_MAX`、`PG_CONNECTION_TIMEOUT_MS`、`PG_SSL_DISABLED`、`RUN_DB_DDL_ON_BOOT` |
| 後台 | `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_LOGIN_PATH`、登入節流變數 |
| LINE 主 OA | `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_OFFICIAL_ADD_FRIEND_URL` |
| LINE 第二 OA | `LINE2_CHANNEL_SECRET`、`LINE2_CHANNEL_ACCESS_TOKEN`、`LINE2_OA_KEY` |
| LIFF | `LIFF_ID`、`GAMES_LIFF_ID`、`WHEEL_LIFF_ID`、`LIFF_TOKEN_ENFORCE`、`LIFF_ENDPOINT_IS_SITE_ROOT` |
| 公開 URL | `PUBLIC_SITE_URL`、`LINE_PUSH_IMAGE_BASE_URL`、`LINE_PUSH_PUBLIC_BASE_URL` |
| Email | `EMAIL_PROVIDER`、`SURENOTIFY_*`、`BREVO_*`、`SMTP_*`、`REVISIT_EMAIL_PROVIDER`、`REVISIT_EMAIL_EWS_*`、`REVISIT_EMAIL_LOCAL_SEND_ENABLED`、`REVISIT_EMAIL_PUBLIC_BASE_URL`、`REVISIT_EMAIL_SEND_INTERVAL_MS` |
| 排程 | `SCHEDULED_RUNNER_SECRET` |
| Booking | `BOOKING_REPORT_DATABASE_URL`、`BOOKING_REPORT_POOL_MAX`、`BOOKING_REPORT_CONNECTION_TIMEOUT_MS`、`BOOKING_REPORT_SSL_DISABLED`、`LEADERBOARD_TOP_N` |
| Gold Pig | `GOLD_PIG_LIFF_ID`、`GOLD_PIG_BOOKING_API_KEY`、`GOLD_PIG_DEMO_MODE`、`GOLD_PIG_ALLOWED_ORIGINS` |

`SKIP_DB_DDL_ON_BOOT` 是舊文件錯誤名稱；現在程式使用的是 `RUN_DB_DDL_ON_BOOT`。

## 12. Netlify 排程

排程定義在 `netlify.toml`，Netlify Functions 以 `SCHEDULED_RUNNER_SECRET` 呼叫站內 runner。

| 工作 | 排程 | 站內 runner |
|---|---|---|
| 排程群發 | 每 5 分鐘 | `/admin/broadcast/run-scheduled` |
| 自動化流程 | 每分鐘 | `/admin/flows/run` |
| Rich Menu 排程 | 每 5 分鐘 | `/admin/richmenu/run-schedule` |
| 標籤規則 | 每 5 分鐘 | `/admin/users/run-tag-rules` |
| 活動排程 | 每 5 分鐘 | `/admin/activities/run-schedule` |
| 月度訂位排行榜 | 每月 1 日 03:30（cron 時區依平台） | `/admin/broadcast/run-monthly-leaderboard` |

不要讓 scheduler 直接繞過既有 runner 的認證、鎖與重送保護。時間需求要先確認 UTC／台北時區。

## 13. 本機開發與測試

```bash
npm ci --include=dev
cp .env.example .env
# 填入本機測試值，絕對不要 commit .env
npm run dev
```

完整測試：

```bash
npm test
```

測試大多使用 mock DB／mock LINE，因此「全部通過」不能取代正式整合測試。按改動範圍追加驗證：

| 改動 | 最低驗證 |
|---|---|
| 通用遊戲 | quota、冪等、缺貨、coupon 競態、邀請、LIFF 驗證 |
| 輪盤 | 每個獎項的伺服器結果與停格角度一致；手機寬度無溢出 |
| 安全預覽 | Network 不出現遊玩／配額／邀請寫入 API |
| 群發／流程 | 去重、排程鎖、失敗重試、provider event |
| Webhook | raw body signature 正確；重送不重複寫入 |
| 加好友邀請 | 已驗簽 follow 當下入帳、last touch、72 小時、新舊好友、webhook／瀏覽器競態、DB 短暫斷線重試 |
| LINE 邀請卡 | Flex 封面／文案／URI CTA，CTA 與文字 fallback 的 `ref` 不可遺失 |
| 權限 | 未登入、staff、admin 三種角色 |
| Schema | migration 可重複套用、索引／constraint／RLS 正確 |

Netlify production install 可能移除 dev dependency `jsdom`。若 build 後要重跑測試，先再次執行 `npm ci --include=dev`。

## 14. 受眾、行為、標籤與 Campaign 成效（2026-09-17）

### 名單庫

- `/admin/recipient-lists` 可建立靜態名單或動態受眾。動態受眾的規則存在
  `admin_recipient_lists.definition`，成員物化至既有 `admin_recipient_list_members`，因此群發與流程仍只消費同一種名單介面。
- 建立靜態名單時可選擇「建立前，只保留符合條件的人」。試算與正式建立都以貼入的 LINE userId 為 scope，採「匯入 ID ∩ 受眾條件」；未勾選時維持原本的純手動名單。前端送 `scopeLineUserIds` 試算、`filterDefinition` 建立，後端必須重新計算，不能信任畫面顯示的人數。
- 條件支援 Include／Exclude 與 Include 間 AND／OR。Exclude 永遠是強制排除，不會因選 OR 而意外把排除者放回名單；只有 Exclude 時語意是「全部有效會員扣掉排除條件」。
- 可用加入日期、目前好友／封鎖狀態、Tag、指定圖文選單／按鈕、LIFF event、活動進入／開始／完成／分享、成功邀請、獎勵、LINE Login、活動手機登記、金豬訂位、群發已發／Email delivered／open／click／測試組／CTA conversion 等條件。現有 `campaign_phone_registrations` 只能證明活動手機登記，不能當作 OpenRice App Registration；後者須等正式身份橋接後才能加入。
- 「點過指定圖文選單按鈕」必須用三段名稱選擇器（圖文選單 → 分頁 → 按鈕），不可要求使用者手填 `menu_id:tab:cell`。畫面顯示人話名稱，儲存時仍轉成既有底層格式，讓舊名單與 `rich_menu_taps` 查詢維持相容。
- 建立畫面會在條件變更後 debounce 即時計數。啟用自動同步的名單由既有 scheduled runner 每五分鐘更新；群發預覽與正式建立批次前仍會強制同步一次，避免送到排程間隔內的舊快照。
- 已建立的動態名單可在列表或詳情頁查看、修改條件並立即同步；同步失敗會顯示最後錯誤。排程每輪以 `last_synced_at NULLS FIRST` 處理最久未同步的 25 筆，避免名單超過上限後永遠只更新較小 id。
- 流程編輯器的「加入名單」步驟可直接建立空白靜態名單，不必離開編輯畫面。這個動作只允許靜態名單；前端、儲存 API 與執行引擎都有防線，避免流程加入的成員被下一次動態重算洗掉。
- 刪除名單前會同時檢查 Automation 與 Rich Menu 引用；仍在使用時回 409，不會留下壞掉的選單或流程。

### 行為追蹤與標籤

- `activity_user_events` 記錄活動 `enter/start/complete/share`；start／complete 以 `play_key` 唯一索引去重，網路重送不會被算成第二次遊戲。成功邀請仍以 `activity_referrals.invitee_was_existing IS FALSE` 為準。
- 圖文選單按鈕用 `rich_menu_taps(menu_id,tab,cell)`；LIFF 開啟／CTA 用 `member_liff_events.event_name`；follow／unfollow 使用已驗簽 webhook 的 `line_webhook_events`。
- `/admin/tag-rules` 支援規則貼標／移除、30 天等有效期限與 reconcile。停用或刪除規則時可選擇保留既有標籤，或只移除該規則自己建立的 membership；人工標籤不受影響。批次貼標可貼已綁定的 LINE userId。
- Automation 流程新增「貼標籤／移除標籤」步驟；貼標可設定有效天數。

### Campaign Testing 與成效漏斗

- `/admin/broadcast` 既有 Campaign Testing 支援隨機 A/B/C、任意合法比例（例如 A 10%／B 10%／Winner holdout 80%）、不同文字／圖片／CTA、互斥測試受眾與 CTR Winner 自動 release。
- 內容版本固定同時發送，避免時間差與文案效果混在一起；要測發送時間應建立獨立、互斥且內容相同的實驗。Booking Winner 在一般 Booking 尚無 LINE identity bridge 前不可開，不能拿猜測資料選 Winner。
- `/admin/campaign-performance` 依自訂日期顯示 Target → Sent → Delivered → Open → Click → LIFF → 活動手機登記 → Booking → Confirmed／Cancel → Attendance 與 Block，並列出 delivery/open/CTR/conversion/block rate。日期預設依 `Asia/Taipei`，不會在台灣午夜後仍顯示前一天。每列同時顯示 Audience 名稱以比較不同名單，Campaign 可逐列比較，A/B/C 區塊比較 Creative。
- 新 LINE 一般訊息的追蹤圖片／CTA 會同時寫入 append-only event table 與 recipients 的 `opened_at`／`first_clicked_at`；成效與動態名單另以 event table 回補舊資料。LINE Flex JSON 無可靠逐人 open／click 時顯示「無資料」，不再誤顯示 0。
- LIFF／活動／Booking 等下游指標目前是「每次發送後 7 天觀察」而非唯一歸因；同一人在重疊期間收到多個 Campaign 時，事件可能出現在多列。頁面會明確提示不可把各列直接相加。
- LINE Messaging API 不提供逐人 delivered／open。LINE Delivered 必須顯示「無資料」；Open 只可能是追蹤圖 proxy。Email Delivered 來自 provider webhook。一般 Booking、OpenRice App Registration 與 Attendance 目前無可靠 LINE ID 對應，也必須顯示「無資料」；目前 Registration 只計活動手機登記，Booking 只計金豬食堂的 LINE 綁定訂位。
- Reward 的「未兌換／已兌換」以 `activity_plays.is_redeemed` 判定，不可用 coupon code 已指派來代替。尚未回寫兌換狀態的哩數或外部獎項會維持未兌換，不能宣稱已領取。
- `Dashboard` 的訂位來源可用 `booking_from`／`booking_to` 自訂日期，首尾都包含且依台灣日界線查詢。

### Schema

- Migration：`supabase/migrations/20260917093000_dynamic_audiences_and_tag_lifecycle.sql`、`supabase/migrations/20260917143000_broadcast_engagement_recipient_fields.sql`。
- Production 不得靠 runtime DDL；正式套 migration 前先確認 schema。Staging 使用 `crm_staging` search path 時可套同一 migration，但必須先確認 current user/schema，不可碰 `public`。

## 15. Git、部署與驗收流程

```bash
git fetch origin
git status --short --branch
git rev-list --left-right --count main...origin/main
git switch -c codex/<task-name> origin/main
npm ci --include=dev
npm test
```

建議流程：

1. 從最新 `origin/main` 開分支，先確認沒有混入其他人的未提交檔案。
2. 小步修改，對應補測試與文件。
3. 跑完整 `npm test`、`git diff --check`，檢視 staged diff。
4. 確認 `origin/main` 沒有前進，再合併或建立 PR。
5. 由 Netlify 從 main 部署；不得直接部署一個落後 main 的本機目錄。
6. 部署後檢查 `/healthz`、`/healthz/db`、受影響路由、console、靜態資源與實際資料狀態。

抽獎與群發屬高風險功能。HTTP 200 只代表頁面有回應，不代表獎品、動畫、庫存、推播或冪等正確。

LINE 群發在測試推播、建立正式批次與每次執行批次前，都會先呼叫 LINE 官方
`/v2/bot/message/validate/push` 驗證訊息而不送出。進階 Flex JSON 另會在 server 端
移除已知不合法的 `text.backgroundColor`（背景色應設在外層 `box`）；不要只相信網頁預覽，
因為瀏覽器可能忽略 LINE 不支援的欄位。測試收件人失敗時，後台應顯示 LINE 回傳的實際
欄位或原因，正式批次不可在驗證失敗時建立或繼續處理。

## 16. 常見需求要改哪裡

| 需求 | 優先查看 |
|---|---|
| 新增／修改活動欄位 | `src/routes/adminActivities.js`、`views/admin_activity_edit.ejs`、`activities.rules` |
| 修改輪盤畫面／文案 | `views/game_wheel.ejs`、`views/admin_activity_edit.ejs`、相關 JSDOM test |
| 修改抽獎／次數／邀請 | `src/core/gamePlayEngine.js` 與對應 test；不要只改前端 |
| 修改 MGM 里程 | `src/core/mgmMilesEngine.js`、`src/routes/mgmMiles.js` |
| 修改群發 | `src/routes/adminBroadcast.js`、provider service、scheduled function |
| 修改 LINE 收訊 | `src/routes/lineWebhook.js` 或 `line2Webhook.js`，保留 raw body |
| 修改 Rich Menu／Flow | 對應 admin route、runner 與排程 function |
| 修改動態受眾 | `src/core/audienceSegments.js`、`src/routes/adminRecipientLists.js`、`views/admin_recipient_lists.ejs` |
| 修改 Campaign 漏斗 | `src/routes/adminCampaignPerformance.js`、`views/admin_campaign_performance.ejs` |
| 修改資料表 | 先補 migration，再改 query／route／test／文件 |
| 新增公開圖片 | `public/`；同時確認 LINE 可抓到的 HTTPS URL 與檔案大小 |

## 17. 已知技術債與風險

1. **Migration 不完整**：目前最大可攜性風險，新環境無法只靠 repo 重建。
2. **Legacy 與新版並存**：名稱相似但資料表與規則不同，容易改錯系統。
3. **命名過時**：`package.json` 與舊交接文件仍保留早期 `line-mgm-lucky-straw` 名稱。
4. **環境文件曾漂移**：舊 `.env.example` 使用不存在的 `SKIP_DB_DDL_ON_BOOT`，已修正文檔但仍要以程式搜尋為準。
5. **Node 版本漂移**：`netlify.toml` 設 Node 18，正式 health 顯示 Node 24。
6. **Build warning**：`src/routes/adminBroadcast.js` 有重複的 `prizes`／`recent` object key 警告，需在獨立任務確認語意後清理。
7. **大型 EJS**：許多頁面的 HTML、CSS、JS 混在單檔，改 UI 容易造成非預期回歸。
8. **整合測試有限**：現有測試大量 mock，無法覆蓋真實 LINE、Email、Netlify scheduler 與正式 DB。
9. **個資風險**：會員、LINE、Email 與訂位資料必須避免進入 log、截圖、fixture 與公開文件。
10. **CSRF 邊界需評估**：目前未見全站統一 token；若擴大後台使用範圍應優先安全檢視。
11. **依賴安全債**：2026-09-03 執行 `npm ci` 回報 15 個已知弱點（3 low、2 moderate、9 high、1 critical）。不要直接使用破壞性 `npm audit fix --force`；應另開任務逐項確認實際可利用性、相容性與升級測試。

不要在處理其他需求時順手大規模重構這些問題；應各自建立可回滾、可驗證的任務。

## 18. 給下一個 AI 的標準接手清單

每次任務開始：

1. 讀 `AGENTS.md` 與本文件。
2. `git fetch origin`，從最新 `origin/main` 工作。
3. 檢查 dirty worktree，保留人類與其他 AI 的修改。
4. 用 route／core／view／test 與正式唯讀資料交叉驗證，不把舊文件當事實。
5. 先寫出此任務會碰到的資料表、權限、外部 API 與失敗模式。

每次任務完成：

1. 補足成功、失敗、重送、權限與手機畫面的測試。
2. 執行完整 `npm test` 與 `git diff --check`。
3. 更新本文件、`.env.example` 或 README 中受到影響的部分。
4. 以單一目的 commit 提交，記錄實際驗證結果。
5. 合併後做 production smoke test，確認資料與畫面，而不只確認 status code。

若本文與程式或正式環境衝突，先查明原因；以已驗證的現場為準，並在同一個變更中修正文件。
