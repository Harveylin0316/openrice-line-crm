const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLineMessages } = require('../src/core/broadcastTemplates');
const { createLinePushService } = require('../src/core/linePush');

function failingFlexConfig() {
  return {
    mode: 'flex_json',
    flex: {
      type: 'flex',
      altText: '分享超有哩',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#FFFFFF',
          contents: [
            {
              type: 'text',
              text: '首次開啟輪盤，先有 1 次抽獎機會',
              color: '#374151',
              backgroundColor: '#FDC627',
              wrap: true
            },
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#FDC627',
              contents: [{ type: 'text', text: '開始抽獎' }]
            }
          ]
        }
      }
    }
  };
}

test('會移除 LINE text 不支援的 backgroundColor，保留 box 背景色且不改原稿', () => {
  const config = failingFlexConfig();
  const built = buildLineMessages(config);

  assert.equal(built.ok, true);
  const body = built.messages[0].contents.body;
  assert.equal(Object.hasOwn(body.contents[0], 'backgroundColor'), false);
  assert.equal(body.contents[1].backgroundColor, '#FDC627');
  assert.equal(config.flex.contents.body.contents[0].backgroundColor, '#FDC627');
});

test('LINE 官方驗證端點成功時不會真的推播', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => '' };
  };
  const service = createLinePushService({ query: async () => ({ rows: [] }), lineChannelAccessToken: 'token' });
  const result = await service.validatePushMessages(buildLineMessages(failingFlexConfig()).messages);

  assert.deepEqual(result, { ok: true, httpStatus: 200, detail: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/validate/push');
  assert.deepEqual(JSON.parse(calls[0].options.body).messages[0].contents.body.contents[0], {
    type: 'text', text: '首次開啟輪盤，先有 1 次抽獎機會', color: '#374151', wrap: true
  });
});

test('LINE 官方驗證錯誤會完整回傳，讓後台顯示真正欄位', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const detail = JSON.stringify({
    message: 'A message in the request body is invalid',
    details: [{ property: '/body/contents/2/backgroundColor', message: 'unknown field' }]
  });
  global.fetch = async () => ({ ok: false, status: 400, text: async () => detail });
  const service = createLinePushService({ query: async () => ({ rows: [] }), lineChannelAccessToken: 'token' });

  assert.deepEqual(await service.validatePushMessages(['測試']), {
    ok: false, httpStatus: 400, detail
  });
});

test('測試推播可選擇回傳詳細結果，舊呼叫仍維持 boolean', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const logs = [];
  const detail = JSON.stringify({ message: 'The user has blocked the OA' });
  global.fetch = async () => ({ ok: false, status: 400, text: async () => detail });
  const service = createLinePushService({
    query: async (_sql, params) => { logs.push(params); return { rows: [] }; },
    lineChannelAccessToken: 'token'
  });
  const userId = 'U' + 'a'.repeat(32);

  assert.equal(await service.pushLineMessages(userId, ['測試']), false);
  assert.deepEqual(
    await service.pushLineMessages(userId, ['測試'], { pushType: 'admin_broadcast_test', returnResult: true }),
    { ok: false, status: 'failed', httpStatus: 400, detail }
  );
  assert.equal(logs.length, 2);
  assert.equal(logs.some((params) => String(params[6]).includes('returnResult')), false);
});
