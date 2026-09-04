const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

function messageConfig() {
  return {
    mode: 'flex_json',
    flex: {
      type: 'flex', altText: '測試卡片',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '內容', backgroundColor: '#FDC627' }
          ]
        }
      }
    }
  };
}

function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.render = () => res;
  res.redirect = () => res;
  res.type = () => res;
  res.send = () => res;
  return res;
}

function build({ validation, pushResult } = {}) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes['GET ' + path] = handlers; },
    post(path, ...handlers) { routes['POST ' + path] = handlers; },
    delete(path, ...handlers) { routes['DELETE ' + path] = handlers; },
    put(path, ...handlers) { routes['PUT ' + path] = handlers; }
  };
  const calls = { validate: [], push: [], query: [] };
  let validationIndex = 0;
  const pass = (_req, _res, next) => next();
  registerAdminBroadcastRoutes(app, {
    query: async (sql) => { calls.query.push(sql); return { rows: [], rowCount: 0 }; },
    pool: { connect: async () => { throw new Error('不該建立正式批次'); } },
    authCore: { requireAdmin: pass },
    linePush: {
      validatePushMessages: async (messages) => {
        calls.validate.push(messages);
        if (typeof validation === 'function') return validation(messages, validationIndex++);
        if (Array.isArray(validation)) return validation[validationIndex++] || validation.at(-1);
        validationIndex++;
        return validation || { ok: true, httpStatus: 200, detail: null };
      },
      pushLineMessages: async (...args) => {
        calls.push.push(args);
        return pushResult === undefined
          ? { ok: true, status: 'success', httpStatus: 200, detail: null }
          : pushResult;
      }
    },
    emailProvider: { isConfigured: () => false },
    lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://example.netlify.app'
  });
  return { routes, calls };
}

async function run(handlers, body) {
  const req = {
    body, params: {}, query: {}, authUser: { uid: 1, un: 'admin' },
    get: () => 'example.netlify.app'
  };
  const res = makeResponse();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test('測試訊息先清理再官方驗證，通過後才推播', async () => {
  const ctx = build();
  const res = await run(ctx.routes['POST /admin/broadcast/test-push'], {
    test_line_user_id: 'U' + 'a'.repeat(32),
    message_config: messageConfig()
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(ctx.calls.validate.length, 1);
  assert.equal(ctx.calls.push.length, 1);
  const text = ctx.calls.validate[0][0].contents.body.contents[0];
  assert.equal(Object.hasOwn(text, 'backgroundColor'), false);
  assert.equal(ctx.calls.push[0][2].returnResult, true);
});

test('LINE 官方驗證未通過時不推播，後台收到可讀的錯誤位置', async () => {
  const detail = JSON.stringify({
    message: 'invalid',
    details: [{ property: '/body/contents/2/backgroundColor', message: 'unknown field' }]
  });
  const ctx = build({ validation: { ok: false, httpStatus: 400, detail } });
  const res = await run(ctx.routes['POST /admin/broadcast/test-push'], {
    test_line_user_id: 'U' + 'a'.repeat(32),
    message_config: messageConfig()
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_line_message');
  assert.equal(res.body.detail, '/body/contents/2/backgroundColor：unknown field');
  assert.equal(ctx.calls.push.length, 0);
});

test('推播失敗時顯示 LINE 原因，不再只有成功 0／失敗 1', async () => {
  const detail = JSON.stringify({ message: 'The user has blocked the OA' });
  const ctx = build({ pushResult: { ok: false, status: 'failed', httpStatus: 400, detail } });
  const res = await run(ctx.routes['POST /admin/broadcast/test-push'], {
    test_line_user_id: 'U' + 'a'.repeat(32),
    message_config: messageConfig()
  });

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'push_failed');
  assert.equal(res.body.detail, 'The user has blocked the OA');
  assert.equal(ctx.calls.push.length, 1);
});

test('正式立即或排程批次在 LINE 驗證失敗時都不會建立名單', async () => {
  for (const sendMode of ['immediate', 'scheduled']) {
    const ctx = build({ validation: { ok: false, httpStatus: 400, detail: '{"message":"invalid flex"}' } });
    const res = await run(ctx.routes['POST /admin/broadcast/create'], {
      send_mode: sendMode,
      scheduled_at: sendMode === 'scheduled' ? '2099-09-05T12:00' : undefined,
      conditions: { all: true },
      message_config: messageConfig()
    });

    assert.equal(res.statusCode, 400, sendMode);
    assert.equal(res.body.error, 'invalid_line_message', sendMode);
    assert.equal(ctx.calls.query.length, 0, sendMode);
  }
});

test('A/B 卡片任一版本不合法都會擋下，不建立正式批次', async () => {
  const ctx = build({
    validation: [
      { ok: true, httpStatus: 200, detail: null },
      { ok: false, httpStatus: 400, detail: '{"message":"variant B invalid"}' }
    ]
  });
  const res = await run(ctx.routes['POST /admin/broadcast/create'], {
    send_mode: 'immediate',
    conditions: { all: true },
    message_config: messageConfig(),
    ab_test: true,
    variant_b_message_config: messageConfig()
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'variant_b_invalid');
  assert.equal(ctx.calls.validate.length, 2);
  assert.equal(ctx.calls.query.length, 0);
});
