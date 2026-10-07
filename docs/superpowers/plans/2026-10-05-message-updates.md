# 訊息更新實作計畫索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付已確認的歡迎設定、四種來源成效、Campaign 人工確認與動態名單排除。
**Architecture:** 三份子計畫各自可驗收；先解決群發控制，再接歡迎設定與共用事件，最後整合報表。沿用既有 sender、流程引擎與追蹤路由，不重建發送系統。
**Tech Stack:** Node.js、Express、pg/PostgreSQL、EJS、原生 JavaScript、node:test/JSDOM。
**Spec:** ../specs/2026-10-05-welcome-message-performance-design.md

## Global Constraints

- 只修改 staging；由使用者 push，本階段不部署、不發送真人訊息。
- 本波不新增歡迎訊息 A/B 分流、不新增訂位完成歸因、不補造歷史事件、不重做既有訊息編輯器。
- 本規格預設只涵蓋主 LINE OA；第二 OA 與 Email 不改動。
- 原生 Imagemap 不轉成 Flex，仍遵守 builder 與 LINE 的 1～5 則限制。
- 新增 schema 附 migration、rollback、索引、RLS；不使用 runtime DDL，不觸碰 public。
- 每份子計畫繼承本節約束；現有未納入本波的行為保持相容。

## Review Focus

1. 既有 auto 批次與新預設 manual 的區別，不能在讀舊資料時偷偷改寫（計畫 1，任務 1）。
2. 動態名單同人退出／重新加入及 A/B 發送不確定仍不能重複補送（計畫 1，任務 2）。
3. webhook 在流程已結束後重送仍不應再次歡迎（計畫 2，任務 2）。
4. 素材更新／刪除後，已送出的連結仍回到當時目的地（計畫 3，任務 1）。
5. 舊資料缺少身分、版本或觀察窗，報表不能補成零或與新資料混算 CTR（計畫 3，任務 2）。

## 執行順序

- [x] [1：Campaign 人工確認與動態名單排除](2026-10-05-campaign-manual-audience.md)
- [x] [2：歡迎訊息與執行資料](2026-10-05-welcome-executions.md)
- [x] [3：追蹤補齊、成效與交付](2026-10-05-message-performance.md)

建議由目前 agent 在同一工作階段依序實作，避免同時修改 adminBroadcast／flowEngine 產生衝突。使用者已批准 inline 依序實作，未授權本次代為 push。

PR title（完整功能完成後使用）：`feat: 加入好友歡迎訊息、統一訊息成效與 Campaign 人工確認`

2026-10-07：三階段程式已完成，本機回歸與獨立審查修正完成。固定 Staging 與 LINE 真機驗收待使用者 push 後進行；最終狀態以 ../../reviews/2026-10-07-message-updates-hen.md 為準。子計畫原始 TDD／commit 步驟未逐條勾選，避免把部分實作後補測試誤列為全部先紅後綠。
