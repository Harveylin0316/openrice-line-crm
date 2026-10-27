# Functions 固定排程用量減量

## 範圍與推估

保留舊免費方案，無migration、憑證、正式資料變更或真人發送。呼叫原排程route時不再經外部HTTP，保留原認證與冪等。每分鐘flow與inbox備援共用一次喚醒；broadcast與richmenu保持獨立timer與原頻率，避免較重工作共用同一個30秒時限。

31天固定基線：

| 排程 | 舊呼叫數 | 新呼叫數 |
| --- | ---: | ---: |
| flow＋inbox備援 | 133,920 | 44,640 |
| broadcast | 17,856 | 8,928 |
| richmenu四工作 | 44,640 | 8,928 |
| 合計 | 196,416 | 62,496 |

額外worker喚醒、月榜、手動工作、Webhook及團隊其他31站不含在基線。不能拿本推估宣稱每月一定免費。原richmenu四工作序列總時限也從分開HTTP改為共用一次函式時限，雲端須實測。

## 驗證與限制

- 新增8項測試：真adapter header/body/route認證、無設定不載app、路徑allowlist、錯誤隔離、保留cron、不重試、richmenu四工作完整執行及退役備援入口匿名403。
- `npm ci --include=dev`及本機完整回歸621/621通過，無正式DB／LINE發送。依netlify.toml轉換設定，使用Netlify zip-it-and-ship-it/esbuild成功打包9個函式，確認flow bundle含views/layout.ejs及pg/ejs；單獨functions:build不讀完整toml的預設zisi結果不作正式打包證據。
- 固定Staging目前因團隊超額503，無法驗收Netlify實際scheduler與bundle執行；PR維持draft直到補驗。
- 發布需Hen核准；沒有直接CLI發布production。

## 恢復與回滾

目前停站不會因這個commit解除。依方案UI11/1重置或由Hen另決定付費後，先驗Staging黃色橫幅、health與三個scheduler的認證／零工作回應、bundle資產與耗時，再核准main。不要用正式有待寄工作的route作測試。

回滾整個減量commit，恢復獨立webhook每分鐘cron及原HTTPwrapper。只改程式，不刪inbox／重送已處理或uncertain事件。若某一工作失敗，先查歷史，不重跑整組已發送工作。
