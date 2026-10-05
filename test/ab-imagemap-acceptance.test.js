'use strict';
// 驗收：同一張圖的 Imagemap A（?variant=a）與 Imagemap B（?variant=b）是兩個不同素材。
// 走實際的正式群發路徑：建立 A/B 批次 → process-chunk 依收件人版本送出（LINE mock）→ 點擊跳板反查。
// 確認 A 收件人拿到 A 的完整 payload、B 收件人拿到 B 的完整 payload，URL 與 UTM 不串版。
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');

const IMAGE = '9b8a7c6d-5e4f-4321-b0a9-8c7d6e5f4a3b';                 // 兩個素材共用同一張圖
const URL_A = 'https://example.com/?variant=a&utm_source=line&utm_campaign=staging_ab';
const URL_B = 'https://example.com/?variant=b&utm_source=line&utm_campaign=staging_ab';
const MAP_A = { mode: 'imagemap', imagemap: { assetId: IMAGE, baseWidth: 1040, baseHeight: 1040, altText: 'STAGING Imagemap A', layout: 'full',
  areas: [{ type: 'uri', uri: URL_A, x: 0, y: 0, width: 1040, height: 1040 }] } };
// B 的結構刻意不同（兩個點擊區、不同通知文字），證明是整份替換而不是只換網址
const MAP_B = { mode: 'imagemap', imagemap: { assetId: IMAGE, baseWidth: 1040, baseHeight: 1040, altText: 'STAGING Imagemap B', layout: 'top_bottom',
  areas: [{ type: 'uri', uri: URL_B, x: 0, y: 0, width: 1040, height: 520 }, { type: 'message', text: 'STAGING 我要B', x: 0, y: 520, width: 1040, height: 520 }] } };
const SEQ_A = { mode: 'sequence', items: [{ type: 'text', text: 'STAGING 文字 A' }, { type: 'card', source_message_id: 71, source_name: 'STAGING Imagemap A', message_config: MAP_A }] };
const SEQ_B = { mode: 'sequence', items: [{ type: 'text', text: 'STAGING 文字 B' }, { type: 'card', source_message_id: 72, source_name: 'STAGING Imagemap B', message_config: MAP_B }] };

function harness() {
  const db = { broadcasts: {}, recipients: [], pushes: [], clicks: [] };
  const audience = [{ user_id: 1, line_user_id: 'U' + 'a'.repeat(32) }, { user_id: 2, line_user_id: 'U' + 'b'.repeat(32) }];
  const exec = async (sql, p = []) => {
    const c = String(sql).replace(/\s+/g, ' ');
    if (/COUNT\(DISTINCT u\.id\)/.test(c)) return { rows: [{ total: 2 }], rowCount: 1 };
    if (/SELECT u\.id AS user_id, u\.line_user_id/.test(c)) return { rows: audience.slice(), rowCount: 2 };
    if (/SELECT u\.id, u\.line_user_id/.test(c)) return { rows: audience.map(a => ({ id: a.user_id, line_user_id: a.line_user_id })), rowCount: 2 };
    if (/INSERT INTO admin_broadcasts/.test(c)) {
      const objs = p.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(x => x && typeof x === 'object');
      const msgs = objs.filter(o => o.mode);
      db.broadcasts[90] = { id: 90, status: 'running', channel: 'line', is_ab_test: true, audience_config: {},
        message_config: msgs[0], variant_b_message_config: msgs[1], recipient_ok: 0, recipient_fail: 0, recipient_skip: 0 };
      return { rows: [{ id: 90 }], rowCount: 1 };
    }
    if (/INSERT INTO admin_broadcast_recipients/.test(c)) {
      for (let i = 0; i < p.length; i += 6) db.recipients.push({ id: db.recipients.length + 1, broadcast_id: p[i], user_id: p[i + 1], line_user_id: p[i + 2], variant: p[i + 4], status: p[i + 5] });
      return { rows: [], rowCount: p.length / 6 };
    }
    if (/SELECT \* FROM admin_broadcasts WHERE id = \$1/.test(c)) return { rows: [db.broadcasts[Number(p[0])]], rowCount: 1 };
    if (/UPDATE admin_broadcast_recipients SET status = 'sending'/.test(c)) {
      const claimed = db.recipients.filter(r => r.status === 'pending');
      claimed.forEach(r => { r.status = 'sending'; });
      return { rows: claimed.map(r => ({ id: r.id, user_id: r.user_id, line_user_id: r.line_user_id, variant: r.variant })), rowCount: claimed.length };
    }
    if (/SELECT line_display_name, blocked_at FROM users/.test(c)) return { rows: [{ line_display_name: 'STAGING', blocked_at: null }], rowCount: 1 };
    if (/UPDATE admin_broadcast_recipients SET status = 'sent'/.test(c)) { db.recipients.find(r => r.id === Number(p[0])).status = 'sent'; return { rows: [], rowCount: 1 }; }
    if (/SELECT message_config, variant_b_message_config, audience_config FROM admin_broadcasts/.test(c)) return { rows: [db.broadcasts[90]], rowCount: 1 };
    if (/INSERT INTO admin_broadcast_clicks/.test(c)) { db.clicks.push(p); return { rows: [], rowCount: 1 }; }
    if (/SELECT line_user_id FROM admin_broadcast_recipients WHERE id/.test(c)) return { rows: [{ line_user_id: null }], rowCount: 1 };
    if (/SELECT COUNT\(\*\)::int AS n FROM admin_broadcast_recipients/.test(c)) return { rows: [{ n: db.recipients.filter(r => r.status === 'pending' || r.status === 'sending').length }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (path, ...h) => { routes[m.toUpperCase() + ' ' + path] = h; }; return o; }, {});
  registerAdminBroadcastRoutes(app, {
    query: exec, pool: { connect: async () => ({ query: exec, release() {} }) }, authCore: { requireAdmin: (_q, _s, n) => n() },
    linePush: { validatePushMessages: async () => ({ ok: true }), pushLineMessages: async (to, messages) => { db.pushes.push({ to, messages }); return true; } },
    emailProvider: { isConfigured: () => false }, lineChannelAccessToken: 'STAGING', resolvePublicSiteOrigin: () => 'https://staging.example'
  });
  const run = async (key, req) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
      type() { return this; }, send(b) { this.body = b; return this; }, redirect(code, url) { this.statusCode = code; this.location = url; return this; } };
    for (const h of routes[key]) { let next = false; await h(Object.assign({ params: {}, query: {}, body: {}, authUser: { un: 'admin' }, get: () => 'staging.example' }, req), res, () => { next = true; }); if (!next) break; }
    return res;
  };
  return { db, run };
}

test('驗收：同圖不同網址的 Imagemap A／B，正式 A/B 群發各送各的完整 payload，點擊導回各自網址（含 UTM）', async () => {
  const { db, run } = harness();
  const created = await run('POST /admin/broadcast/create', { body: {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true }, ab_test: true,
    message_config: SEQ_A, variant_b_message_config: SEQ_B
  } });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  // 批次分別保存 A、B 兩份快照，B 的素材來源是 #72
  assert.equal(db.broadcasts[90].message_config.items[1].source_message_id, 71);
  assert.equal(db.broadcasts[90].variant_b_message_config.items[1].source_message_id, 72);
  // 兩個收件人一個 A 一個 B（若隨機分到同一邊就手動指定，避免測試看運氣）
  db.recipients[0].variant = 'a'; db.recipients[1].variant = 'b';

  const sent = await run('POST /admin/broadcast/:id/process-chunk', { params: { id: '90' }, body: { chunkSize: 50 } });
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.equal(db.pushes.length, 2);
  const byUser = Object.fromEntries(db.pushes.map(x => [x.to, x.messages]));
  const msgA = byUser['U' + 'a'.repeat(32)];
  const msgB = byUser['U' + 'b'.repeat(32)];

  // 共用同一張圖（baseUrl 相同），但其餘是各自的完整設定
  assert.deepEqual(msgA.map(m => m.type), ['text', 'imagemap']);
  assert.deepEqual(msgB.map(m => m.type), ['text', 'imagemap']);
  assert.equal(msgA[1].baseUrl, msgB[1].baseUrl, '同一張圖');
  assert.equal(msgA[0].text, 'STAGING 文字 A');
  assert.equal(msgB[0].text, 'STAGING 文字 B');
  assert.equal(msgA[1].altText, 'STAGING Imagemap A');
  assert.equal(msgB[1].altText, 'STAGING Imagemap B');
  assert.equal(msgA[1].actions.length, 1);
  assert.equal(msgB[1].actions.length, 2, 'B 的點擊區設定整份帶入');
  assert.deepEqual(msgB[1].actions[0].area, { x: 0, y: 0, width: 1040, height: 520 });
  assert.equal(msgB[1].actions[1].type, 'message');
  assert.equal(msgB[1].actions[1].text, 'STAGING 我要B');

  // 送出的連結是追蹤跳板，點下去導回各自的原網址（UTM 完整保留）
  const followRedirect = async (linkUri) => {
    const m = /\/r\/b\/(\d+)\/(\d+)\/(\d+)\?v=([abc])$/.exec(linkUri);
    assert.ok(m, '追蹤連結格式：' + linkUri);
    const r = await run('GET /r/b/:broadcastId(\\d+)/:recipientId(\\d+)/:buttonIndex(\\d+)',
      { params: { broadcastId: m[1], recipientId: m[2], buttonIndex: m[3] }, query: { v: m[4] } });
    return { status: r.statusCode, location: r.location, variant: m[4] };
  };
  const clickA = await followRedirect(msgA[1].actions[0].linkUri);
  const clickB = await followRedirect(msgB[1].actions[0].linkUri);
  assert.deepEqual(clickA, { status: 302, location: URL_A, variant: 'a' });
  assert.deepEqual(clickB, { status: 302, location: URL_B, variant: 'b' });
  assert.doesNotMatch(JSON.stringify(msgB), /variant=a/, 'B 版 payload 不可出現 A 的網址');
  assert.doesNotMatch(JSON.stringify(msgA), /variant=b/, 'A 版 payload 不可出現 B 的網址');
  // 點擊紀錄分得出版本
  assert.deepEqual(db.clicks.map(c => c[5]), ['a', 'b']);
});
