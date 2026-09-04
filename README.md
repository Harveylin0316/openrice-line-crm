# OpenRice LINE CRM

OpenRice Taiwan 的 LINE 官方帳號 CRM 與 LIFF 活動平台。系統把會員、標籤與名單、LINE／Email 群發、自動化流程、圖文選單、活動遊戲、優惠券、邀請歸因與數據分析集中在同一個 Express 應用。

## 目前正式環境

- 正式站：<https://openrice-line-crm.netlify.app>
- GitHub：<https://github.com/Harveylin0316/openrice-line-crm>
- 部署：Netlify Functions
- 主資料庫：PostgreSQL（Supabase，以 `pg` 直連）
- 本文件狀態：2026-09-04，依最新 `main` 整理

## 交接閱讀順序

1. [AGENTS.md](./AGENTS.md)：AI／工程代理的工作規則與不可破壞的系統邊界。
2. [docs/AI_HANDOFF.md](./docs/AI_HANDOFF.md)：完整產品、架構、資料流、模組、環境、測試、部署及已知風險。
3. [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md)：早期「春日野餐刮刮樂」歷史交接；僅供追溯，不代表目前完整系統。

## 技術摘要

- Node.js + Express 4 + EJS + 原生瀏覽器 JavaScript
- PostgreSQL / Supabase；後端使用 `pg`，不是 `supabase-js`
- LINE LIFF、Messaging API、Webhook、Rich Menu
- LINE 與 Email（SureNotify／Brevo）訊息
- Netlify Scheduled Functions 執行群發、流程、活動、標籤與圖文選單排程
- 測試使用 Node test runner 與 JSDOM

## 本機啟動

```bash
npm ci --include=dev
cp .env.example .env
# 填入本機可用的 DATABASE_URL、JWT_SECRET 等；不要提交 .env
npm run dev
```

正式環境預設不執行建表。全新資料庫不能只依賴目前 repo 內的 migration；詳見 [資料庫章節](./docs/AI_HANDOFF.md#8-資料庫與資料模型)。

## 測試

```bash
npm test
```

2026-09-04 的基準為 74 項測試全數通過。任何抽獎、配額、邀請、群發、圖文選單或權限改動，都必須先跑完整測試。

## 重要提醒

- 不要從落後的本機 `main` 直接部署。先 `git fetch origin`，確認與 `origin/main` 的差異。
- LINE Webhook 必須在 `express.json()` 之前使用 raw body 驗簽。
- Serverless 回應送出後可能凍結執行環境；必要的 DB 紀錄與 LINE 推播必須 `await`。
- 通用遊戲的剩餘次數一律使用 `computeUserQuota()`，不要另寫第二套公式。
- `activities/activity_*` 是新版活動平台；`prizes/draw_logs/line_invites` 是早期春日刮刮樂系統，兩者不要混用。
- `.env`、token、資料庫密碼及登入路徑不得提交到 Git。
