# OR 開飯任務：關注通知第一階段（2026-11-02）

目前是可聯測的測試端實作，不是正式任務上線。正式站不啟用，不發獎、不補發歷史事件、不增加排程。

## 接收與保存

沿用 LINE 簽章驗證。新 follow 事件與通知待辦在同一 SQL 交易語句保存；同一 webhookEventId 重送只存一次。保存 LINE userId、事件時間、解除封鎖標記，不據此判定 OR 會員、任務完成或獎勵資格。

必須同時 APP_ENV=staging、SAFE_PREVIEW_MODE=1、OR_MISSION_FOLLOW_CAPTURE_ENABLED=1。正式環境強制關閉。Migration 僅允許 search_path=crm_staging，public 會拒絕執行；開 RLS，只有專用後端角色有存取政策。

## 香港通知客戶端

固定 Chris 提供的 staging-api.openrice.com /v6/api/job/enqueue/user/follow/account，參數 accountId=1、accountType=openricelinepage、imTypeId=130、imKey=LINE userId。此 GET 有入隊副作用，不是唯讀查詢。

createStagingSender 尚未接公開路由、排程或自動通知。另須 OR_MISSION_STAGING_SEND_ENABLED=1 才能呼叫，測試站保持 0。每筆只允許一次嘗試，禁止 redirect。2xx 只記 http_accepted_unverified，不能宣稱任務成功；逾時或寫回失敗不重送，需 OR 協助對帳。不同 follow 事件的任務級去重仍待 OR 契約。

## 待聯測／確認

- API 認證、IP 白名單、業務成功回應及冪等／重試規則。
- 原本已關注及解除封鎖者是否符合任務，會員／任務級去重由誰負責。
- OR 登入／任務頁對既有好友補查；follow 事件本身不能涵蓋既有好友。
- 正式 API、參數與驗收帳號。Jira OR-96496 目前無法連入，未讀取其規格。

## 驗證與回滾

node --test test/or-mission-follow.test.js test/line-webhook-inbox.test.js。
CRM_QA_ISOLATED=1 node scripts/qa/or-mission-follow-check.cjs：只使用本機獨立暫存 PostgreSQL DB；驗證五次併發去重、交易回滾、一次嘗試、結果不明不重送、RLS／權限及重複套用／回滾。HTTP 使用模擬，未呼叫香港 API。

先關閉兩旗標，再回退程式。非空通知表禁止 SQL rollback，保留紀錄；只有空表可套 supabase/rollbacks/20261102075511_or_mission_follow_notifications.sql。不得刪歷史以強制重送。
