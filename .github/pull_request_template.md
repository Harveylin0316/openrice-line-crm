> 日常測試站修改可直接 push `staging`，不需 PR。這份樣板主要用於已驗證的 `staging -> main` 正式上線申請。

## 這次要做什麼

請用一至三句白話說明用戶問題與預期結果。

## 改了哪些地方

- 功能／路由：
- 主要檔案：
- 用戶路徑：

## 風險與資料

- [ ] 不會修改正式資料或 schema
- [ ] 若有 migration，已附上 migration、影響評估與 rollback SQL
- [ ] 沒有將 token、密碼、LINE User ID、Email 或電話寫入 commit
- [ ] 不會誤觸群發、抽獎、邀請、排程或其他 production 寫入

## 怎麼驗證

- [ ] `npm ci --include=dev`
- [ ] `npm test`
- [ ] `git diff --check origin/main...HEAD`
- [ ] 已在固定 Staging 站實際走過受影響用戶路徑
- [ ] UI 改動已驗證桌機與 390px 手機畫面、console 無錯誤

測試結果：

```text
請貼最後的測試摘要，不要貼憶證或個資。
```

## 畫面證據

若有 UI 改動，請放改前／改後截圖或固定 Staging 網址。

## 如何回滾

說明可回滾的 commit、設定或 SQL。「再修一版」不是 rollback 方法。

## Hen 核准

- [ ] Hen 已確認固定 Staging 與上述風險
