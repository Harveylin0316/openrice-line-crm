# 回訪郵件編輯器與範本驗收

Hen要求郵件式撰寫與保存範本，維持 Outlook mailto 與人工確認寄出，不引入 HTML 失真。

## 改動

- 郵件 envelope／主旨／內文／即時純文字預覽；另存範本及套用，舊版本不覆蓋。
- 範本只改單封編輯區，儲存／寄送另有明確動作；代入當前姓名與餐廳、保留 CTA。
- 未儲存切換提醒、載入／儲存競態防護、owner權限、DB失敗不假成功。
- 新範本表RLS，匿名與authenticated不授權；staging專用角色只SELECT/INSERT。

## 驗證證據

- 完整 npm test 589/589；syntax與diff check。
- scripts/qa/revisit-composer-check.cjs：真 PostgreSQL隔離DB，重複migration、空表rollback、非空rollback拒絕；真HTTP保存重載。
- 真實EJS＋Playwright Edge獨立headless：1440px／390px，保存、切換、代入、CTA保留、儲存這封、重載；無水平溢出／page error。
- 截圖在本次Mac `/tmp/revisit-composer-1440.png`、`/tmp/revisit-composer-390.png`，虛構資料，不含客戶資料。非固定Staging登入截圖。
- crm_staging 已套 migration與catalog驗證；管理MCP不能SET ROLE crm_staging_app（權限不足），不假稱該角色遠端CRUD已實測。固定Staging尚無登入驗收，發布時另驗靜態檔與未登入API保護。
- 未寄信、未開啟客戶 Outlook 草稿、未改既有訂位／寄送紀錄。真人預設郵件程式交接需操作人確認。

## 發布與回滾

staging→main PR，先套public migration再合併，等待正式ready及health/db、新檔雜湊／未登入API保護。
程式可revert本次commit；無範本時rollback SQL可刪新表，有任何範本時拒絕刪表，保留內容只回退程式。不要刪既有回訪狀態或操作稽核。

Hen已有常態正式發布授權。本次不操作任何真實郵件發送。
