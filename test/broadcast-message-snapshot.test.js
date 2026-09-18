const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const {
  buildBroadcastMessageSnapshots,
  getBroadcastMessageIdentity,
  summarizeConfig
} = require('../src/core/broadcastMessageSnapshot');

const REPO = path.join(__dirname, '..');

test('群發詳情摘要會保留一般卡片的辨識文字、圖片與 CTA', () => {
  const result = buildBroadcastMessageSnapshots({
    channel: 'line',
    audience_config: { messageSource: { id: 31, name: '回流寶箱' } },
    message_config: {
      mode: 'template',
      template: {
        heroMediaId: 'e280fccf-5762-408b-b554-c0b5098fbf85',
        title: '原來你什麼都不想要？',
        subtitle: '回饋金入帳通知',
        ctaLabel: '查看回饋金',
        ctaUrl: 'https://example.com/reward',
        altText: '回饋金已入帳'
      }
    }
  }, { origin: 'https://crm.example.com/' });

  assert.equal(result.channelLabel, 'LINE 推播');
  assert.equal(result.sourceName, '回流寶箱');
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].summary.notificationText, '回饋金已入帳');
  assert.equal(result.variants[0].summary.title, '原來你什麼都不想要？');
  assert.deepEqual(result.variants[0].summary.images, [
    'https://crm.example.com/p/line-media/e280fccf-5762-408b-b554-c0b5098fbf85'
  ]);
  assert.deepEqual(result.variants[0].summary.actions[0], {
    type: 'uri', label: '查看回饋金', url: 'https://example.com/reward', invalidUrl: false
  });
});

test('A/B/C 與多段訊息會各自顯示，不把版本混在一起', () => {
  const result = buildBroadcastMessageSnapshots({
    is_ab_test: true,
    message_config: { mode: 'template', template: { title: 'A 版' } },
    variant_b_message_config: { mode: 'template', template: { title: 'B 版' } },
    audience_config: {
      experiment: {
        enabled: true,
        variantCount: 3,
        variantCMessageConfig: {
          mode: 'sequence',
          items: [
            { type: 'text', text: 'C 版先發文字' },
            { type: 'image', originalContentUrl: 'https://example.com/c.jpg', previewImageUrl: 'https://example.com/c-preview.jpg' }
          ]
        }
      }
    }
  });

  assert.deepEqual(result.variants.map((item) => item.label), ['版本 A', '版本 B', '版本 C']);
  assert.equal(result.variants[0].summary.title, 'A 版');
  assert.equal(result.variants[1].summary.title, 'B 版');
  assert.equal(result.variants[2].summary.mode, 'sequence');
  assert.equal(result.variants[2].summary.segments[0].summary.texts[0], 'C 版先發文字');
  assert.equal(result.variants[2].summary.segments[1].summary.images[0], 'https://example.com/c-preview.jpg');
});

test('自訂 Flex 摘要抓出通知文字、卡片文字、圖片與連結', () => {
  const summary = summarizeConfig({
    mode: 'flex_json',
    flex: {
      type: 'flex',
      altText: '本週優惠',
      contents: {
        type: 'bubble',
        hero: { type: 'image', url: 'https://example.com/hero.jpg' },
        body: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '第一行標題' },
            { type: 'text', text: '第二行內文' },
            {
              type: 'box', layout: 'vertical',
              action: { type: 'uri', uri: 'https://example.com/go' },
              contents: [{ type: 'text', text: '馬上看' }]
            }
          ]
        }
      }
    }
  });

  assert.equal(summary.notificationText, '本週優惠');
  assert.equal(summary.title, '第一行標題');
  assert.ok(summary.texts.includes('第二行內文'));
  assert.deepEqual(summary.images, ['https://example.com/hero.jpg']);
  assert.deepEqual(summary.actions[0], { type: 'uri', label: '馬上看', url: 'https://example.com/go' });
});

test('群發歷史優先用訊息庫名稱辨識，舊紀錄退回通知文字', () => {
  const named = getBroadcastMessageIdentity({
    audience_config: { messageSource: { id: 9, name: '中秋回流提醒' } },
    message_config: { mode: 'template', template: { altText: '今晚訂位有優惠', title: '中秋開飯' } }
  });
  assert.equal(named.title, '中秋回流提醒');
  assert.equal(named.preview, '今晚訂位有優惠');

  const legacy = getBroadcastMessageIdentity({
    message_config: { mode: 'template', template: { altText: '舊批次通知', title: '舊批次內容' } }
  });
  assert.equal(legacy.title, '舊批次通知');
  assert.equal(legacy.preview, '舊批次內容');
});

test('發送詳情的訊息快照可渲染且會 HTML escape', async () => {
  const snapshot = buildBroadcastMessageSnapshots({
    channel: 'line',
    message_config: {
      mode: 'template',
      template: { title: '<script>alert(1)</script>', ctaLabel: '查看', ctaUrl: 'https://example.com' }
    }
  });
  const html = await ejs.renderFile(
    path.join(REPO, 'views', 'partials', 'broadcast_message_snapshot.ejs'),
    { messageSnapshots: snapshot },
    { views: [path.join(REPO, 'views')] }
  );
  assert.match(html, /這次發送的訊息/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /查看完整設定 JSON/);
});
