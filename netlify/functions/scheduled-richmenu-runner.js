/**
 * Netlify Scheduled Function：每 5 分鐘於同 invocation 跑既有四個 route
 *   1. 圖文選單上下架（到點設為所有人看到的／換成替補選單）
 *   2. 自動貼標籤（新達標的人貼上標籤）
 *   3. 活動上下架（到開始時間自動變進行中、過結束時間自動變已結束）
 * 環境變數：URL、SCHEDULED_RUNNER_SECRET（與群發共用）
 */
const { dispatch } = require('../lib/schedulerDispatch');
exports.handler = async () => {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
  if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'missing_URL_env' }) };
  if (!secret) return { statusCode: 200, body: JSON.stringify({ skipped: 'no_SCHEDULED_RUNNER_SECRET' }) };
  const call = async (path) => {
    const res = await dispatch(path, 'netlify-scheduled-richmenu');
    return { status: res.statusCode, body: res.body };
  };
  try {
    const menu = await call('/admin/richmenu/run-schedule');   // 圖文選單上下架
    const tags = await call('/admin/users/run-tag-rules');     // 自動貼標籤
    const acts = await call('/admin/activities/run-schedule'); // 活動上下架
    const audiences = await call('/admin/recipient-lists/run-dynamic'); // 動態名單加入／移除
    const failed = [menu, tags, acts, audiences].some(r => r.status >= 400);
    return { statusCode: failed ? 500 : 200, body: JSON.stringify({ menu, tags, acts, audiences }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
