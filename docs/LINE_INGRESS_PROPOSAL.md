# LINE收件入口候選：Cloudflare Queue（未部署、未切換）

11/6已由Hen核准開啟LINE Webhook redelivery。告警保持開啟，不能把重送當成消除逾時。

原Netlify路徑外部合成測試曾2.888秒；嘗試省context.next的staging候選ff8d0a6仍4.160秒，直接背景入口也有3.162秒。候選已revert，不發布正式。背景回應0bytes，標頭至完成0ms，不支持body卡住。有限Mac樣本不能當LINE正式延遲分布。

候選流程：LINE → Cloudflare驗原始HMAC → await Queue持久保存 → 回200；consumer將原始bytes／簽章交Netlify既有background function，只有平台202接受後才ack。未知傳輸結果保留重送，既有DB event_id防重。CRM、DB、業務回覆及LINE發送權限不搬移。

一般80KiB以下原始request保存於Queue；超過80KiB至256KiB維持既有DB-before-ack receiver直送，因此大型request仍可能逾時，不假稱所有情境根治。Queue失敗回503，不能提前成功。無waitUntil／KV／新cron，payload不進日誌。

需要的資料／權限：現有Cloudflare帳號新增Queues write、2個Queue與1個Worker；正式啟用時須將此channel的LINE_CHANNEL_SECRET安全設為Worker secret。原始LINE事件（含訊息、LINE識別及短效replyToken）將在此帳號Queue短暫保存；Free每個Queue retention24小時，超額／長期供應商故障仍有風險。DLQ保留另一期24小時；沒有自動管理端告警或永久存檔。不能保證零告警或exactly-once訊息送達。

Cloudflare官方Free含10,000 Queue operations/日，無資料傳出費；一般小訊息成功一輪約3operations，重送／大訊息／DLQ另外計算，與同帳號其他Queues共用。須查實際方案與用量，未升級付費或承諾永不超額。

目前Wrangler OAuth缺queues:write。先完成本機合成測試與dry-run，尚未新增資源、複製正式secret或接收真實LINE資料。需Hen核准此具體範圍，再以最小新增scope授權；隔離QA完整入庫／去重／耗時驗證通過後，正式程式仍依staging→main發布規則及Hen核准執行，最後才能切換LINE URL。不得先改正式URL賭成功。

部署初始設定ENABLED=0；QA只能轉固定staging，production只能轉固定正式host。回滾：LINE URL改回原Netlify（redelivery保持開），停止新入口後先排空queue，不purge或丟棄未交付事件。既有DB／活動／憑證不重設。

官方依據：
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://docs.netlify.com/build/functions/background-functions/
