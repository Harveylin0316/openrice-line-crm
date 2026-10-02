'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineMessages } = require('../src/core/broadcastTemplates');
const ke = require('../src/core/keywordExperiments');
const { createLinePushService, normalizeLinePushMessageItem } = require('../src/core/linePush');

const cfg = { mode: 'sequence', items: [
  { type: 'text', text: 'SYNTHETIC intro' },
  { type: 'card', message_config: { mode: 'imagemap', imagemap: {
    assetId: '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b', baseHeight: 780, altText: 'SYNTHETIC map',
    areas: [
      { type: 'uri', uri: 'https://example.com/test', x: 0, y: 0, width: 520, height: 780 },
      { type: 'message', text: 'SYNTHETIC reply', x: 520, y: 0, width: 520, height: 780 }
    ]
  } } }
] };
const built = () => buildLineMessages(cfg, { heroImageBaseUrl: 'https://crm.example' }).messages;

test('shared sender preserves native imagemap, areas, and text+map order without leaking metadata', () => {
  const messages = built();
  const normalized = messages.map(normalizeLinePushMessageItem).filter(Boolean);
  assert.deepEqual(normalized, messages);
  assert.deepEqual(normalized.map(m => m.type), ['text', 'imagemap']);
  const withMetadata = { ...messages[1], source_message_id: 7, internal: 'never send' };
  assert.deepEqual(normalizeLinePushMessageItem(withMetadata), messages[1]);
  const video = { originalContentUrl: 'https://example.com/test.mp4', previewImageUrl: 'https://example.com/test.jpg',
    area: { x: 0, y: 0, width: 520, height: 780 } };
  assert.deepEqual(normalizeLinePushMessageItem({ ...messages[1], video }).video, video);
});

test('shared sender rejects incomplete imagemap envelopes', () => {
  const msg = built()[1];
  for (const bad of [
    { ...msg, baseUrl: '' }, { ...msg, baseUrl: 'http://example.com/map' }, { ...msg, altText: '' },
    { ...msg, baseSize: null }, { ...msg, baseSize: { width: 700, height: 780 } },
    { ...msg, baseSize: { width: 1040, height: 0 } }, { ...msg, actions: [] },
    { ...msg, actions: Array(51).fill(msg.actions[0]) }
  ]) assert.equal(normalizeLinePushMessageItem(bad), null);
});

test('push, provider validation, plain reply, and A/B detailed reply submit the complete native payload', async () => {
  const originalFetch = global.fetch;
  const requests = [], logs = [];
  const messages = built();
  global.fetch = async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };
  try {
    const svc = createLinePushService({ lineChannelAccessToken: 'SYNTHETIC_TOKEN',
      query: async (_sql, p) => { logs.push(JSON.parse(p[6])); return { rows: [] }; } });
    assert.equal(await svc.pushLineMessages('U' + 'a'.repeat(32), messages), true);
    assert.equal((await svc.validatePushMessages(messages)).ok, true);
    assert.equal(await svc.replyLineMessages('SYNTHETIC_REPLY', messages), true);
    assert.equal((await svc.replyLineMessagesDetailed('SYNTHETIC_REPLY_AB', messages)).status, 'accepted');
    assert.deepEqual(requests.map(r => r.path), ['/v2/bot/message/push', '/v2/bot/message/validate/push',
      '/v2/bot/message/reply', '/v2/bot/message/reply']);
    for (const r of requests) assert.deepEqual(r.body.messages, messages);
    assert.equal(logs.length, 3);
    for (const log of logs) assert.deepEqual(log.messages, messages);
  } finally { global.fetch = originalFetch; }
});

test('A/B imagemap tracking URLs survive the real sender normalization; message actions stay unchanged', async () => {
  const originalFetch = global.fetch;
  const messages = ke.buildExperimentMessages(cfg, {
    origin: 'https://crm.example', deliveryCode: 'SYNTHETICcode1234567890', liffId: 'SYNTHETIC-LIFF'
  }).messages;
  let request;
  global.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200 }; };
  try {
    const svc = createLinePushService({ query: async () => ({ rows: [] }), lineChannelAccessToken: 'SYNTHETIC_TOKEN' });
    assert.equal((await svc.replyLineMessagesDetailed('SYNTHETIC', messages)).status, 'accepted');
    assert.deepEqual(request.messages.map(m => m.type), ['text', 'imagemap']);
    assert.equal(request.messages[1].actions[0].linkUri,
      'https://liff.line.me/SYNTHETIC-LIFF/t/x/SYNTHETICcode1234567890_0');
    assert.equal(request.messages[1].actions[1].text, 'SYNTHETIC reply');
  } finally { global.fetch = originalFetch; }
});
