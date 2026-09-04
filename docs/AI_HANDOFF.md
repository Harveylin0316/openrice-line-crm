# OpenRice LINE CRM — AI 完整接手手冊

本文件讓新的 AI 或工程師不需依賴對話紀錄，即可理解產品、找到程式入口、安全修改並完成驗證。內容依 2026-09-03 的 `origin/main`（基準 commit `fdfac35`）與正式站唯讀檢查整理。

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
| `src/routes/adminFlows.js` | 自動化流程編輯與執行 |
| `src/routes/adminRichmenu.js` | Rich Menu 管理與排程 |
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

### 數據與歸因

- 洞察／報告：`/admin/insight`、`/admin/reports`
- 歸因與邀請：`/admin/attribution`、`/admin/referrals`
- LIFF／Random Rice：`/admin/liff/random-rice`
- RFM：`/admin/rfm`

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

### 正式規則基準

- 每位符合資格的使用者至少可玩 1 次。
- 每成功邀請 1 位原本不是 OA 好友的人，再加 1 次。
- 好友邀請最多加 3 次，因此未含人工補次時最多可玩 4 次。
- 原本已是好友的人可以玩自己的首次機會，但不替邀請人增加次數。
- 抽到的獎項直接留在抽獎頁「我的獎項」，不要求使用者再點另一個頁面查看。
- 邀請好友使用 LINE Flex Message 卡片：封面圖、標題與說明讀 activity 資料，「馬上玩」CTA 必須保留 `?ref=<inviter LINE user ID>`。
- Flex 無法送出時會退回文字連結；分享成功本身不加次數，仍要等新好友透過連結加入 OA。

上述數字仍應從 activity rules 讀取，不能在 view 寫死。

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
| Email | `EMAIL_PROVIDER`、`SURENOTIFY_*`、`BREVO_*` |
| 排程 | `SCHEDULED_RUNNER_SECRET` |
| Booking | `BOOKING_REPORT_DATABASE_URL`、`BOOKING_REPORT_POOL_MAX`、`BOOKING_REPORT_CONNECTION_TIMEOUT_MS`、`BOOKING_REPORT_SSL_DISABLED`、`LEADERBOARD_TOP_N` |
| Gold Pig | `GOLD_PIG_LIFF_ID`、`GOLD_PIG_BOOKING_API_KEY`、`GOLD_PIG_DEMO_MODE`、`GOLD_PIG_ALLOWED_ORIGINS` |

`SKIP_DB_DDL_ON_BOOT` 是舊文件錯誤名稱；現在程式使用的是 `RUN_DB_DDL_ON_BOOT`。

## 12. Netlify 排程

排程定義在 `netlify.toml`，Netlify Functions 以 `SCHEDULED_RUNNER_SECRET` 呼叫站內 runner。

| 工作 | 排程 | 站內 runner |
|---|---|---|
| 排程群發 | 每 5 分鐘 | `/admin/broadcast/run-scheduled` |
| 自動化流程 | 每 5 分鐘，錯開秒段 | `/admin/flows/run` |
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

## 14. Git、部署與驗收流程

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

## 15. 常見需求要改哪裡

| 需求 | 優先查看 |
|---|---|
| 新增／修改活動欄位 | `src/routes/adminActivities.js`、`views/admin_activity_edit.ejs`、`activities.rules` |
| 修改輪盤畫面／文案 | `views/game_wheel.ejs`、`views/admin_activity_edit.ejs`、相關 JSDOM test |
| 修改抽獎／次數／邀請 | `src/core/gamePlayEngine.js` 與對應 test；不要只改前端 |
| 修改 MGM 里程 | `src/core/mgmMilesEngine.js`、`src/routes/mgmMiles.js` |
| 修改群發 | `src/routes/adminBroadcast.js`、provider service、scheduled function |
| 修改 LINE 收訊 | `src/routes/lineWebhook.js` 或 `line2Webhook.js`，保留 raw body |
| 修改 Rich Menu／Flow | 對應 admin route、runner 與排程 function |
| 修改資料表 | 先補 migration，再改 query／route／test／文件 |
| 新增公開圖片 | `public/`；同時確認 LINE 可抓到的 HTTPS URL 與檔案大小 |

## 16. 已知技術債與風險

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

## 17. 給下一個 AI 的標準接手清單

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
