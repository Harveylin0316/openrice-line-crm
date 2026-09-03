/**
 * Netlify Scheduled Function：每 5 分鐘跑一次的三件事
 *   1. 圖文選單上下架（到點設為所有人看到的／換成替補選單）
 *   2. 自動貼標籤（新達標的人貼上標籤）
 *   3. 活動上下架（到開始時間自動變進行中、過結束時間自動變已結束）
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
    const acts = await call('/admin/activities/run-schedule'); // 活動上下架
    return { statusCode: 200, body: JSON.stringify({ menu, tags, acts }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
