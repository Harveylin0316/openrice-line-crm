'use strict';
// 群發成效追蹤：模板、訊息庫自訂 Flex、Carousel、多段訊息都要有點擊與看過。
// 批次 8/9/10（訊息庫素材）送達 1291 人卻 0 點擊，就是因為只有模板模式有追蹤。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLineMessages, resolveBroadcastButtonTarget, listBroadcastButtons, BROADCAST_WALK_OPTS
} = require('../src/core/broadcastTemplates');
const { walkUriActions, isTrackerUri } = require('../src/core/messageTapTracking');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
const { registerAdminFlowsRoutes } = require('../src/routes/adminFlows');

const ORIGIN = 'https://crm.example';
const LIFF_URL = 'https://liff.line.me/2007974193-3AWiL11Y/scratch/summer';

function bubble(text, uri, label, withFooter) {
  const button = { type: 'button', style: 'primary', action: { type: 'uri', label, uri } };
  const b = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text }] } };
  if (withFooter) b.footer = { type: 'box', layout: 'vertical', contents: [button] };
  else b.body.contents.push(button);
  return b;
}
const BUTTON_CARD = { mode: 'flex_json', flex: { type: 'flex', altText: '按鈕卡片', contents: bubble('來玩', LIFF_URL, '馬上玩', true) } };
const CAROUSEL = { mode: 'flex_json', flex: { type: 'flex', altText: 'Carousel', contents: { type: 'carousel', contents: [
  bubble('中秋抽機票', LIFF_URL, '去抽', false),
  bubble('分享輪盤', 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles', '去轉', true),
  bubble('看餐廳', 'https://www.openrice.com/zh/taipei/r-100', '看看', true)
] } } };
const SEQUENCE = { mode: 'sequence', items: [
  { type: 'text', text: '哈囉 {暱稱}' },
  { type: 'card', message_config: BUTTON_CARD },
  { type: 'card', message_config: { mode: 'template', template: { title: '模板卡', subtitle: '副標', ctaLabel: '看優惠', ctaUrl: 'https://example.com/offer', altText: '模板' } } }
] };

function uris(messages) {
  const out = [];
  walkUriActions({ contents: messages }, (item) => { out.push(item.uri); }, BROADCAST_WALK_OPTS);
  return out;
}
function pixels(messages) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'image' && /\/v\/b\//.test(String(n.url || ''))) out.push(n.url);
    Object.keys(n).forEach(k => walk(n[k]));
  };
  walk(messages);
  return out;
}

test('自訂 Flex 按鈕卡片：CTA（自家 LIFF）包成 /r/b/<批次>/<收件人>/<序號>，卡片底部有 1px 看過追蹤圖', () => {
  const built = buildLineMessages(BUTTON_CARD, { heroImageBaseUrl: ORIGIN, broadcastId: 8, recipientId: 501, recipientName: '' });
  assert.equal(built.ok, true);
  assert.deepEqual(uris(built.messages), []);            // 已包過的不會再被列成可追蹤按鈕
  const footer = built.messages[0].contents.footer.contents;
  assert.equal(footer[0].action.uri, ORIGIN + '/r/b/8/501/0');
  assert.deepEqual(pixels(built.messages), [ORIGIN + '/v/b/8/501/pixel.png']);
  const pixel = footer[footer.length - 1];
  assert.equal(pixel.type, 'image');
  assert.equal(pixel.size, '1px');
});

test('Carousel：每張卡片的按鈕各自有序號、每張都塞看過追蹤圖，反查回正確目的網址', () => {
  const built = buildLineMessages(CAROUSEL, { heroImageBaseUrl: ORIGIN, broadcastId: 9, recipientId: 7, variant: 'b', recipientName: '' });
  assert.equal(built.ok, true);
  const bubbles = built.messages[0].contents.contents;
  assert.equal(bubbles[0].body.contents[1].action.uri, ORIGIN + '/r/b/9/7/0?v=b');
  assert.equal(bubbles[1].footer.contents[0].action.uri, ORIGIN + '/r/b/9/7/1?v=b');
  assert.equal(bubbles[2].footer.contents[0].action.uri, ORIGIN + '/r/b/9/7/2?v=b');
  assert.equal(pixels(built.messages).length, 3);
  assert.ok(pixels(built.messages).every(u => u === ORIGIN + '/v/b/9/7/pixel.png?v=b'));
  // 沒有 footer 的那張會被補一個 footer 放追蹤圖，原本 body 不變
  assert.equal(bubbles[0].footer.contents[0].type, 'image');
  assert.equal(bubbles[0].body.contents.length, 2);

  assert.equal(resolveBroadcastButtonTarget(CAROUSEL, 0, { heroImageBaseUrl: ORIGIN }).uri, LIFF_URL);
  assert.equal(resolveBroadcastButtonTarget(CAROUSEL, 2, { heroImageBaseUrl: ORIGIN }).uri, 'https://www.openrice.com/zh/taipei/r-100');
  assert.equal(resolveBroadcastButtonTarget(CAROUSEL, 3, { heroImageBaseUrl: ORIGIN }), null);
  assert.deepEqual(listBroadcastButtons(CAROUSEL, { heroImageBaseUrl: ORIGIN }).map(b => b.label), ['去抽', '去轉', '看看']);
});

test('多段訊息：整串一起數序號，文字段不佔序號，模板卡也一起包', () => {
  const built = buildLineMessages(SEQUENCE, { heroImageBaseUrl: ORIGIN, broadcastId: 10, recipientId: 3, recipientName: 'Ice' });
  assert.equal(built.ok, true);
  assert.equal(built.messages[0].type, 'text');
  assert.equal(built.messages[0].text, '哈囉 Ice');
  assert.equal(built.messages[1].contents.footer.contents[0].action.uri, ORIGIN + '/r/b/10/3/0');
  const templateUris = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.action && n.action.type === 'uri') templateUris.push(n.action.uri); Object.keys(n).forEach(k => k !== 'action' && walk(n[k])); };
  walk(built.messages[2]);
  assert.deepEqual(templateUris, [ORIGIN + '/r/b/10/3/1']);
  assert.equal(pixels(built.messages).length, 2);
  assert.equal(resolveBroadcastButtonTarget(SEQUENCE, 1, { heroImageBaseUrl: ORIGIN }).uri, 'https://example.com/offer');
});

test('沒有批次或收件人（測試訊息、後台預覽）不包追蹤、不塞追蹤圖；模板模式行為不變', () => {
  const preview = buildLineMessages(CAROUSEL, { heroImageBaseUrl: ORIGIN, recipientName: '' });
  assert.deepEqual(uris(preview.messages), [LIFF_URL, 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles', 'https://www.openrice.com/zh/taipei/r-100']);
  assert.equal(pixels(preview.messages).length, 0);
  const noRecipient = buildLineMessages(BUTTON_CARD, { heroImageBaseUrl: ORIGIN, broadcastId: 8, recipientName: '' });
  assert.equal(pixels(noRecipient.messages).length, 0);
  assert.equal(noRecipient.messages[0].contents.footer.contents[0].action.uri, LIFF_URL);
  const template = buildLineMessages(SEQUENCE.items[2].message_config, { heroImageBaseUrl: ORIGIN, broadcastId: 5, recipientId: 6, recipientName: '' });
  const templateUris = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.action && n.action.type === 'uri') templateUris.push(n.action.uri); Object.keys(n).forEach(k => k !== 'action' && walk(n[k])); };
  walk(template.messages);
  assert.deepEqual(templateUris, [ORIGIN + '/r/b/5/6']);
  assert.equal(isTrackerUri(ORIGIN + '/r/b/5/6'), true);
  assert.equal(isTrackerUri('https://example.com/rf-page/1'), false);
});

function makeRoutes(register, query, extra) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((out, method) => {
    out[method] = (path, ...handlers) => { routes[method.toUpperCase() + ' ' + path] = handlers; };
    return out;
  }, {});
  register(app, Object.assign({ query }, extra));
  return routes;
}
function response() {
  return {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    type(v) { this.headers['content-type'] = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; }
  };
}

test('/r/b/<批次>/<收件人>/<序號> 用序號反查目的網址、寫入 button_index 並 302', async () => {
  const sql = [];
  const routes = makeRoutes(registerAdminBroadcastRoutes, async (text, params) => {
    const c = String(text).replace(/\s+/g, ' ');
    sql.push({ c, params });
    if (/SELECT message_config, variant_b_message_config/.test(c)) return { rowCount: 1, rows: [{ message_config: BUTTON_CARD, variant_b_message_config: CAROUSEL, audience_config: {} }] };
    if (/SELECT line_user_id FROM admin_broadcast_recipients/.test(c)) return { rowCount: 1, rows: [{ line_user_id: null }] };
    return { rowCount: 1, rows: [] };
  }, {
    pool: { connect: async () => { throw new Error('no pool'); } },
    authCore: { requireAdmin: (_r, _s, n) => n() }, linePush: null, emailProvider: null,
    lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ORIGIN
  });
  const handlers = routes['GET /r/b/:broadcastId(\\d+)/:recipientId(\\d+)/:buttonIndex(\\d+)'];
  assert.ok(handlers, '應註冊帶按鈕序號的點擊路由');

  const resA = response();
  await handlers[0]({ params: { broadcastId: '9', recipientId: '7', buttonIndex: '0' }, query: {}, get: () => '' }, resA);
  assert.equal(resA.statusCode, 302);
  assert.equal(resA.redirectUrl, LIFF_URL);
  const insert = sql.find(s => /INSERT INTO admin_broadcast_clicks/.test(s.c));
  assert.match(insert.c, /button_index/);
  assert.equal(insert.params[6], 0);
  assert.match(insert.c, /SET first_clicked_at = COALESCE\(first_clicked_at, NOW\(\)\)/);

  // B 版是 Carousel：第 3 顆是餐廳連結
  const resB = response();
  await handlers[0]({ params: { broadcastId: '9', recipientId: '7', buttonIndex: '2' }, query: { v: 'b' }, get: () => '' }, resB);
  assert.equal(resB.redirectUrl, 'https://www.openrice.com/zh/taipei/r-100');

  // 序號超出範圍 → 404，絕不從網址帶目的地
  const res404 = response();
  await handlers[0]({ params: { broadcastId: '9', recipientId: '7', buttonIndex: '9' }, query: {}, get: () => '' }, res404);
  assert.equal(res404.statusCode, 404);
});

test('pixel.gif 也吃 Campaign Testing 的 c 版並寫入看過紀錄', async () => {
  const sql = [];
  const routes = makeRoutes(registerAdminBroadcastRoutes, async (text, params) => {
    const c = String(text).replace(/\s+/g, ' ');
    sql.push({ c, params });
    if (/SELECT email, line_user_id FROM admin_broadcast_recipients/.test(c)) return { rowCount: 1, rows: [{ email: null, line_user_id: 'U1' }] };
    return { rowCount: 1, rows: [] };
  }, {
    pool: { connect: async () => { throw new Error('no pool'); } },
    authCore: { requireAdmin: (_r, _s, n) => n() }, linePush: null, emailProvider: null,
    lineChannelAccessToken: '', resolvePublicSiteOrigin: () => ORIGIN
  });
  const handlers = routes['GET /v/b/:bid(\\d+)/:rid(\\d+)/pixel.:ext(gif|png)'];
  const res = response();
  await handlers[0]({ params: { bid: '9', rid: '7', ext: 'png' }, query: { v: 'c' }, get: () => 'LINE/14' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.body.slice(1, 4).toString(), 'PNG');
  const view = sql.find(s => /INSERT INTO admin_broadcast_views/.test(s.c));
  assert.equal(view.params[5], 'c');
});

test('自動化流程：自訂 Flex 的按鈕帶序號，/rf 反查得到目的網址（以前一律 404）', async () => {
  const sql = [];
  const routes = makeRoutes(registerAdminFlowsRoutes, async (text, params) => {
    const c = String(text).replace(/\s+/g, ' ');
    sql.push({ c, params });
    if (/SELECT message_config FROM admin_message_templates/.test(c)) return { rowCount: 1, rows: [{ message_config: CAROUSEL }] };
    if (/SELECT line_user_id FROM admin_flow_enrollments/.test(c)) return { rowCount: 1, rows: [{ line_user_id: null }] };
    return { rowCount: 1, rows: [] };
  }, { authCore: { requireAdmin: (_r, _s, n) => n() }, pool: {}, linePush: null, flowEngine: {} });
  const handlers = routes['GET /rf/:enrollmentId(\\d+)/:messageId(\\d+)/:buttonIndex(\\d+)?'];
  assert.ok(handlers, '應註冊帶序號的流程點擊路由');
  const res = response();
  await handlers[0]({ params: { enrollmentId: '5', messageId: '31', buttonIndex: '1' }, query: {}, get: () => '' }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.redirectUrl, 'https://liff.line.me/2007974193-3AWiL11Y/wheel/share-miles');
  assert.ok(sql.some(s => /INSERT INTO admin_flow_clicks/.test(s.c)));
  // 舊連結沒有序號 → 第 0 顆
  const legacy = response();
  await handlers[0]({ params: { enrollmentId: '5', messageId: '31' }, query: {}, get: () => '' }, legacy);
  assert.equal(legacy.redirectUrl, LIFF_URL);
});
