/**
 * Netlify Scheduled Function：每 5 分鐘檢查圖文選單的上下架排程。
 * 呼叫 /admin/richmenu/run-schedule，該 endpoint 會：
 *   1. 到上架時間的已發布選單 → 設為所有人看到的
 *   2. 到下架時間的選單 → 換成指定的替補選單，或不顯示選單
 * 環境變數：URL、SCHEDULED_RUNNER_SECRET（與群發共用）
 */
exports.handler = async () => {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
  if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'missing_URL_env' }) };
  if (!secret) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_SCHEDULED_RUNNER_SECRET' }) };
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'X-Scheduler-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'netlify-scheduled-richmenu' })
    });
    return { status: res.status, body: await res.text() };
  };
  try {
    const menu = await call('/admin/richmenu/run-schedule');   // 圖文選單上下架
    const tags = await call('/admin/users/run-tag-rules');     // 自動貼標籤
    return { statusCode: 200, body: JSON.stringify({ menu, tags }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
