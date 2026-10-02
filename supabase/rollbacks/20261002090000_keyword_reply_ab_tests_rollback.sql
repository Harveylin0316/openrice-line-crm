-- 回滾：關鍵字回覆 A/B 測試（20261002090000_keyword_reply_ab_tests.sql）
-- 只刪除這次新增的 4 張表；不影響任何既有資料表。
-- 注意：會一併刪除所有 A/B 實驗設定、分組、回覆與點擊紀錄，執行前請先匯出需要保留的報表。
-- 程式必須先回滾到不使用這些資料表的版本，再執行本檔，否則關鍵字回覆在查詢實驗時會記錄錯誤
-- （程式已設計成查詢失敗就照原本規則回覆，不會中斷回覆）。
BEGIN;
DROP TABLE IF EXISTS keyword_reply_experiment_clicks;
DROP TABLE IF EXISTS keyword_reply_experiment_deliveries;
DROP TABLE IF EXISTS keyword_reply_experiment_assignments;
DROP TABLE IF EXISTS keyword_reply_experiments;
COMMIT;
