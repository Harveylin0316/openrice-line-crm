# LINE收件入口候選：Cloudflare Queue（隔離QA已部署；正式未切換）

11/6已由Hen核准開啟LINE Webhook redelivery。告警保持開啟，不能把重送當成消除逾時。

原Netlify路徑外部合成測試曾2.888秒；嘗試省context.next的staging候選ff8d0a6仍4.160秒，直接背景入口也有3.162秒。候選已revert，不發布正式。背景回應0bytes，標頭至完成0ms，不支持body卡住。有限Mac樣本不能當LINE正式延遲分布。

候選流程：LINE → Cloudflare驗原始HMAC → await Queue持久保存 → 回200；consumer將原始bytes／簽章交Netlify既有background function，只有平台202接受後才ack。未知傳輸結果保留重送，既有DB event_id防重。CRM、DB、業務回覆及LINE發送權限不搬移。

一般80KiB以下原始request保存於Queue；超過80KiB至256KiB維持既有DB-before-ack receiver直送，因此大型request仍可能逾時，不假稱所有情境根治。Queue失敗回503，不能提前成功。無waitUntil／KV／新cron，payload不進日誌。

需要的資料／權限：現有Cloudflare帳號新增Queues write、2個Queue與1個Worker；正式啟用時須將此channel的LINE_CHANNEL_SECRET安全設為Worker secret。原始LINE事件（含訊息、LINE識別及短效replyToken）將在此帳號Queue短暫保存；Free每個Queue retention24小時，超額／長期供應商故障仍有風險。DLQ保留另一期24小時；沒有自動管理端告警或永久存檔。不能保證零告警或exactly-once訊息送達。

Cloudflare官方Free含10,000 Queue operations/日，無資料傳出費；一般小訊息成功一輪約3operations，重送／大訊息／DLQ另外計算，與同帳號其他Queues共用。須查實際方案與用量，未升級付費或承諾永不超額。

Hen已核准Queues OAuth及隔離QA；帳號具queues:write，已建立openrice-line-ingress-qa及其DLQ、QA Worker，僅複製與正式不同的staging簽章secret。正式secret未複製，LINE正式URL未切換。正式仍須依staging→main及Hen核准執行。

11/6真實雲端測試：先暫停QA consumer，10次簽章假事件均200、0.506–0.691秒，CRM零列；恢復後發現Cloudflare不支援redirect:error，資料保留重試。修為manual（不跟轉址）後，新10次全部200、0.507–0.671秒，9個唯一事件皆done，重複ID僅一列；最慢事件時間至入庫1.269秒。先前故障批次也在重試補入中；回覆token可能過期，不能把保留資料當成真人回覆成功。全部使用未知假事件、沒有LINE發送token，無真人訊息。原始測試於outputs/crm-webhook-alert-20261106/queue-live-qa.json。

Cloudflare runtime不支援redirect:error是本次雲端QA發現的相容性問題；manual僅接受202，3xx不跟隨且retry。錯誤日誌只保留固定stage代碼，不記錄錯誤原文／事件內容。

部署初始設定ENABLED=0；QA只能轉固定staging，production只能轉固定正式host。回滾：LINE URL改回原Netlify（redelivery保持開），停止新入口後先排空queue，不purge或丟棄未交付事件。既有DB／活動／憑證不重設。

官方依據：
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://docs.netlify.com/build/functions/background-functions/
