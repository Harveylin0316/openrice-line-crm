const {createReceiver} = require('../../src/core/lineWebhookInbox');
const {query,wake} = require('../../src/core/lineWebhookInboxRuntime');
exports.handler = createReceiver({query,wake,channelSecret:process.env.LINE_CHANNEL_SECRET});
