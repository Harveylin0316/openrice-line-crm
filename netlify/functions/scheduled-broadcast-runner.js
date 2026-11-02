/**
 * Netlify Scheduled Function：每 5 分鐘觸發一次。
 *
 * 工作：同 invocation 內呼叫既有 /admin/broadcast/run-scheduled，
 * 該 endpoint 會：
 *   1. 把到期的 scheduled broadcasts 改 running
 *   2. 對所有 running broadcasts 各跑一輪 chunk（50 個 recipients）
 *
 * 保持邏輯集中在 Express route，認證、鎖與重送保護不變。
 *
 * 環境變數：
 *   - URL：Netlify 自動注入的主網域（譬如 https://line-mgm-luckystraw.netlify.app）
 *   - SCHEDULED_RUNNER_SECRET：跟 server 端共享的 secret，避免外部觸發
 *
 * Schedule 在 netlify.toml 設定。
 */

const { dispatch } = require('../lib/schedulerDispatch');
exports.handler = async () => {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
  if (!baseUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_URL_env' }) };
  }
  if (!secret) {
    // 沒設 secret 就 skip（避免裸跑被濫用）
    return { statusCode: 200, body: JSON.stringify({ skipped: 'no_SCHEDULED_RUNNER_SECRET' }) };
  }
  try {
    return await dispatch('/admin/broadcast/run-scheduled', 'netlify-scheduled');
  } catch (e) {
    console.error('scheduled-broadcast-runner error:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};
