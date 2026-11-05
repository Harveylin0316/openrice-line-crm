const {equal,signature,createDrain,createReceiver} = require('../../src/core/lineWebhookInbox');
const {query,claim,wake} = require('../../src/core/lineWebhookInboxRuntime').createRuntime({worker:true});
exports.handler = async event => {
  const started = Date.now();
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
  if (!equal(headers['x-scheduler-secret'],process.env.SCHEDULED_RUNNER_SECRET) || !process.env.LINE_CHANNEL_SECRET) return;
  // Edge handoff carries the original signed body. Netlify already persisted
  // this invocation before returning 202; a DB failure must throw so its managed
  // retry can persist it later. Never acknowledge a dropped in-memory promise.
  if (event.body) {
    const {stagingCaptureEnabled} = require('../../src/core/orMissionFollow');
    const received = await createReceiver({query,channelSecret:process.env.LINE_CHANNEL_SECRET,
      missionCaptureEnabled:stagingCaptureEnabled()})( {...event,httpMethod:'POST'} );
    if (received.statusCode !== 200) throw new Error('line_handoff_persist_failed');
  }
  // Lazy load the full app only inside the accepted, authenticated background invocation.
  const drain = createDrain({query,claim,processEvent:async payload => {
    const app = require('../../server');
    const body = Buffer.from(JSON.stringify(payload));
    let status = 200;
    const res = {status(n){status=n;return this;},json(){return this;},send(){return this;}};
    await app.locals.processLineWebhook({body,get:name=>name.toLowerCase()==='x-line-signature'?signature(body,process.env.LINE_CHANNEL_SECRET):undefined},res);
    return status >= 200 && status < 300;
  }});
  const result = await drain();
  console.info(JSON.stringify({event:'line_webhook_worker_finished',processed:result.processed,
    uncertain:result.uncertain,duration_ms:Date.now()-started,budget_exhausted:result.budgetExhausted}));
  // A slow batch can exhaust its budget before hitting 20 events. Continue now
  // rather than leaving the rest to the minute rescue (reply tokens expire).
  if (result.processed === 20 || result.budgetExhausted) await wake(3000);
};
