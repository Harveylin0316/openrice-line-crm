const {createReceiver} = require('../../src/core/lineWebhookInbox');
const {query,wake} = require('../../src/core/lineWebhookInboxRuntime');
const {stagingCaptureEnabled} = require('../../src/core/orMissionFollow');
exports.handler = createReceiver({query,wake,channelSecret:process.env.LINE_CHANNEL_SECRET,
  missionCaptureEnabled:stagingCaptureEnabled()});
