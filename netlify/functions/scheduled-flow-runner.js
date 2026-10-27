/**
 * Netlify Scheduled Function：每分鐘觸發自動化流程引擎。
 *
 * 在同一次 invocation 內呼叫既有 /admin/flows/run（不走對外 HTTP），該 endpoint 會：
 *   1. 跑 schedule 觸發（到點的定時流程 enroll 受眾）
 *   2. 跑 event 觸發（掃 user_events 新事件 enroll）
 *   3. 推進所有到期的 enrollment（發訊息 / 等待 / 條件分支）
 *
 * 同時執行 webhook inbox 每分鐘備援；該備援不另設 schedule。
 * 環境變數：URL、SCHEDULED_RUNNER_SECRET（與群發共用）
 * Schedule 在 netlify.toml 設定。
 */

const { dispatch } = require('../lib/schedulerDispatch');

// Preserve minute precision. Rescue runs independently of flow errors, and both
// are awaited. Neither failure triggers a blind retry of the other job.
function createMinuteRunner(runFlow, rescue) {
  return async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(runFlow), Promise.resolve().then(rescue)
    ]);
    const failed = results.some(r => r.status === 'rejected' || r.value?.statusCode >= 400);
    return {
      statusCode: failed ? 500 : 200,
      body: JSON.stringify({
        flow: results[0].status === 'fulfilled' ? results[0].value.statusCode : 'failed',
        inbox: results[1].status === 'fulfilled' ? results[1].value.statusCode : 'failed'
      })
    };
  };
}
exports.createMinuteRunner = createMinuteRunner;
exports.handler = createMinuteRunner(
  () => dispatch('/admin/flows/run', 'netlify-scheduled-flows'),
  () => require('./scheduled-line-webhook-runner').runRescue()
);
