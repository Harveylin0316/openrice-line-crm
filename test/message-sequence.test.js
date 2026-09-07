const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineMessages } = require('../src/core/broadcastTemplates');

test('多段訊息可依序組合文字、圖片、影片與卡片', () => {
  const built = buildLineMessages({ mode: 'sequence', items: [
    { type: 'text', text: '嗨 {暱稱}，這是提醒' },
    { type: 'image', originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/a-small.jpg' },
    { type: 'video', originalContentUrl: 'https://example.com/a.mp4', previewImageUrl: 'https://example.com/a-cover.jpg' },
    { type: 'card', message_config: { mode: 'template', template: {
      title: '活動卡片', subtitle: '點下面查看', ctaLabel: '馬上看', ctaUrl: 'https://example.com', altText: '活動卡片'
    } } }
  ] }, { recipientName: 'Hen' });
  assert.equal(built.ok, true, built.error);
  assert.deepEqual(built.messages.map(m => m.type), ['text', 'image', 'video', 'flex']);
  assert.equal(built.messages[0].text, '嗨 Hen，這是提醒');
  assert.equal(built.messages[2].previewImageUrl, 'https://example.com/a-cover.jpg');
});

test('多段訊息擋下超過五段與不安全媒體網址', () => {
  const tooMany = buildLineMessages({ mode: 'sequence', items: Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' })) });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /1～5/);
  const badVideo = buildLineMessages({ mode: 'sequence', items: [
    { type: 'video', originalContentUrl: 'http://example.com/a.mp4', previewImageUrl: 'https://example.com/a.jpg' }
  ] });
  assert.equal(badVideo.ok, false);
  assert.match(badVideo.error, /https/);
});
