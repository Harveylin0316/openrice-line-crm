// 群發派送遊玩機會：設定跟著批次存、送達成功才入帳、同一人同一批次只給一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  normalizePlayGrant, getPlayGrant, grantedKey, grantPlaysForRecipient, applyExclusiveMode
} = require('../src/core/broadcastPlayGrant');
const { registerAdminBroadcastRoutes } = require('../src/routes/adminBroadcast');
const { computeQuotaNumbers } = require('../src/core/gamePlayEngine');

const REPO = path.join(__dirname, '..');
const UID = (n) => 'U' + n.toString(16).padStart(32, '0');

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

async function runRoute(handlers, body, params = {}) {
  const req = { body, params, query: {}, authUser: { uid: 1, un: 'admin' }, get: () => 'staging.test' };
  const res = makeResponse();
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

function trackedMessage() {
  return { mode: 'template', template: { title: '刮刮樂來了', subtitle: '點進去刮', ctaLabel: '馬上玩', ctaUrl: 'https://liff.line.me/x/scratch/summer', altText: '刮刮樂' } };
}

/**
 * 模擬 DB：活動、批次、收件人、bonus plays 都存在記憶體，
 * 用 SQL 關鍵字分派，只實作這個功能會碰到的查詢。
 */
function buildHarness({ activity, pushResults } = {}) {
  pushResults = pushResults || {};
  const db = {
    activity: Object.assign({ id: 9, slug: 'summer', name: '夏日刮刮樂', game_type: 'scratch', status: 'active', base_plays_per_user: 1 }, activity || {}),
    broadcasts: {},
    recipients: [],
    bonus: [],
    nextBroadcastId: 100,
    nextRecipientId: 1
  };
  const calls = { pushes: [] };
  const audience = [1, 2, 3].map(i => ({ user_id: i, line_user_id: UID(i) }));

  async function exec(sql, params = []) {
    const c = String(sql).replace(/\s+/g, ' ').trim();
    if (/COUNT\(DISTINCT u\.id\)/.test(c)) return { rows: [{ total: audience.length }], rowCount: 1 };
    if (/SELECT u\.id AS user_id, u\.line_user_id/.test(c)) return { rows: audience.slice(), rowCount: audience.length };
    if (/SELECT u\.id, u\.line_user_id/.test(c)) return { rows: audience.map(a => ({ id: a.user_id, line_user_id: a.line_user_id, line_display_name: 'x', username: null })), rowCount: audience.length };
    if (/FROM activities WHERE id = \$1 LIMIT 1/.test(c)) {
      return Number(params[0]) === db.activity.id ? { rows: [db.activity], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/UPDATE activities SET base_plays_per_user = 0/.test(c)) {
      const changed = Number(params[0]) === db.activity.id && db.activity.base_plays_per_user !== 0;
      if (changed) db.activity.base_plays_per_user = 0;
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (/INSERT INTO admin_broadcasts/.test(c)) {
      const id = db.nextBroadcastId++;
      const isScheduled = /'scheduled'/.test(c);
      const audienceConfig = JSON.parse(isScheduled ? params[2] : params[1]);
      const messageConfig = JSON.parse(isScheduled ? params[3] : params[2]);
      db.broadcasts[id] = { id, status: isScheduled ? 'scheduled' : 'running', audience_config: audienceConfig, message_config: messageConfig,
        variant_b_message_config: null, is_ab_test: false, channel: 'line', recipient_ok: 0, recipient_fail: 0, recipient_skip: 0 };
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/INSERT INTO admin_broadcast_recipients/.test(c)) {
      for (let i = 0; i < params.length; i += 6) {
        db.recipients.push({ id: db.nextRecipientId++, broadcast_id: params[i], user_id: params[i + 1], line_user_id: params[i + 2], email: params[i + 3], variant: params[i + 4], status: params[i + 5] });
      }
      return { rows: [], rowCount: params.length / 6 };
    }
    if (/SELECT \* FROM admin_broadcasts WHERE id = \$1/.test(c)) {
      const b = db.broadcasts[Number(params[0])];
      return b ? { rows: [b], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/UPDATE admin_broadcast_recipients SET status = 'sending'/.test(c)) {
      const claimed = db.recipients.filter(r => r.broadcast_id === Number(params[0]) && r.status === 'pending').slice(0, Number(params[1]));
      claimed.forEach(r => { r.status = 'sending'; });
      return { rows: claimed.map(r => ({ id: r.id, user_id: r.user_id, line_user_id: r.line_user_id, email: r.email, variant: r.variant })), rowCount: claimed.length };
    }
    if (/SELECT line_display_name, blocked_at FROM users/.test(c)) return { rows: [{ line_display_name: '測試', blocked_at: null }], rowCount: 1 };
    if (/UPDATE admin_broadcast_recipients SET status = 'sent'/.test(c)) {
      const r = db.recipients.find(x => x.id === Number(params[0])); if (r) r.status = 'sent';
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE admin_broadcast_recipients SET status = 'failed'/.test(c)) {
      const r = db.recipients.find(x => x.id === Number(params[0])); if (r) r.status = 'failed';
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE admin_broadcast_recipients SET status = 'skipped'/.test(c)) {
      const r = db.recipients.find(x => x.id === Number(params[0])); if (r) r.status = 'skipped';
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO activity_bonus_plays/.test(c)) {
      const key = params[4];
      if (db.bonus.some(b => b.granted_key === key)) return { rows: [], rowCount: 0 };
      db.bonus.push({ activity_id: params[0], line_user_id: params[1], plays: params[2], reason: params[3], granted_key: key });
      return { rows: [{ id: db.bonus.length }], rowCount: 1 };
    }
    if (/UPDATE admin_broadcasts SET recipient_ok/.test(c)) return { rows: [], rowCount: 1 };
    if (/SELECT COUNT\(\*\)::int AS n FROM admin_broadcast_recipients WHERE broadcast_id = \$1 AND status IN/.test(c)) {
      const n = db.recipients.filter(r => r.broadcast_id === Number(params[0]) && (r.status === 'pending' || r.status === 'sending')).length;
      return { rows: [{ n }], rowCount: 1 };
    }
    if (/UPDATE admin_broadcasts SET status = \$2/.test(c)) {
      const b = db.broadcasts[Number(params[0])]; if (b) b.status = params[1];
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const client = { query: exec, release() {} };
  const routes = {};
  const app = {
    get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; },
    delete(p, ...h) { routes['DELETE ' + p] = h; }, put(p, ...h) { routes['PUT ' + p] = h; }
  };
  const pass = (_req, _res, next) => next();
  registerAdminBroadcastRoutes(app, {
    query: exec,
    pool: { connect: async () => client },
    authCore: { requireAdmin: pass },
    linePush: {
      validatePushMessages: async () => ({ ok: true }),
      pushLineMessages: async (to) => {
        calls.pushes.push(to);
        const outcome = pushResults && Object.prototype.hasOwnProperty.call(pushResults, to) ? pushResults[to] : true;
        return outcome;
      }
    },
    emailProvider: { isConfigured: () => false },
    lineChannelAccessToken: 'token',
    resolvePublicSiteOrigin: () => 'https://staging.test'
  });
  return { routes, db, calls, pushResults };
}

test('派送設定只接受 1–100 的整數與兩種模式，關閉時回 null', () => {
  assert.equal(normalizePlayGrant(undefined).value, null);
  assert.equal(normalizePlayGrant({ enabled: false, activityId: 9, plays: 2 }).value, null);
  assert.deepEqual(normalizePlayGrant({ activityId: 9, plays: 3, mode: 'exclusive' }).value, { activityId: 9, plays: 3, mode: 'exclusive' });
  assert.equal(normalizePlayGrant({ activityId: 9, plays: 0 }).ok, false);
  assert.equal(normalizePlayGrant({ activityId: 9, plays: 101 }).ok, false);
  assert.equal(normalizePlayGrant({ activityId: 9, plays: 2.5 }).ok, false);
  assert.equal(normalizePlayGrant({ activityId: 'x', plays: 2 }).ok, false);
  assert.equal(normalizePlayGrant({ activityId: 9, plays: 2, mode: 'weird' }).ok, false);
  assert.equal(normalizePlayGrant({ activityId: 9, plays: 2 }).value.mode, 'additive');
  assert.equal(grantedKey(77, 9, UID(1)), 'broadcast:77:9:' + UID(1));
  assert.equal(getPlayGrant({ audience_config: {} }), null);
  assert.equal(getPlayGrant({ audience_config: { playGrant: { activityId: 9, plays: 999, mode: 'nope' } } }).plays, 100);
});

test('基礎次數 0 的活動：沒收到派送就是 0 次，收到派送就有 N 次', () => {
  const nobody = computeQuotaNumbers({ basePlays: 0, refPer: 0, refMax: 0, invitesPer: 1, newFriends: 0, manualBonus: 0, played: 0, override: null });
  assert.equal(nobody.total, 0);
  assert.equal(nobody.remaining, 0);
  const granted = computeQuotaNumbers({ basePlays: 0, refPer: 0, refMax: 0, invitesPer: 1, newFriends: 0, manualBonus: 3, played: 1, override: null });
  assert.equal(granted.total, 3);
  assert.equal(granted.remaining, 2);
});

test('入帳寫入具冪等：同一批次同一人第二次不再新增，格式不對的 ID 不寫', async () => {
  const inserted = [];
  const query = async (sql, params) => {
    if (inserted.includes(params[4])) return { rows: [], rowCount: 0 };
    inserted.push(params[4]);
    return { rows: [{ id: 1 }], rowCount: 1 };
  };
  const grant = { activityId: 9, plays: 2, mode: 'additive' };
  assert.equal(await grantPlaysForRecipient(query, { broadcastId: 5, grant, lineUserId: UID(1) }), true);
  assert.equal(await grantPlaysForRecipient(query, { broadcastId: 5, grant, lineUserId: UID(1) }), false);
  assert.equal(await grantPlaysForRecipient(query, { broadcastId: 5, grant, lineUserId: 'not-a-line-id' }), false);
  assert.equal(await grantPlaysForRecipient(query, { broadcastId: 5, grant: null, lineUserId: UID(1) }), false);
  assert.equal(inserted.length, 1);
});

test('exclusive 模式只把基礎次數改成 0；additive 不動活動', async () => {
  const sqls = [];
  const client = { query: async (sql, params) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rowCount: 1 }; } };
  assert.equal(await applyExclusiveMode(client, { activityId: 9, mode: 'exclusive' }), true);
  assert.match(sqls[0].sql, /UPDATE activities SET base_plays_per_user = 0/);
  assert.doesNotMatch(sqls[0].sql, /rules/);
  assert.equal(await applyExclusiveMode(client, { activityId: 9, mode: 'additive' }), false);
  assert.equal(sqls.length, 1);
});

test('建立批次會把派送設定（含活動快照）存進 audience_config，exclusive 模式同交易把基礎次數改 0', async () => {
  const ctx = buildHarness();
  const res = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: trackedMessage(),
    play_grant: { enabled: true, activityId: 9, plays: 2, mode: 'exclusive' }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.playGrant, { activityId: 9, activityName: '夏日刮刮樂', plays: 2, mode: 'exclusive', basePlaysSetToZero: true });
  const b = ctx.db.broadcasts[res.body.broadcastId];
  assert.equal(b.audience_config.playGrant.activitySlug, 'summer');
  assert.equal(b.audience_config.playGrant.gameType, 'scratch');
  assert.equal(b.audience_config.playGrant.previousBasePlays, 1);
  assert.equal(ctx.db.activity.base_plays_per_user, 0);
});

test('additive 模式不改活動基礎次數；找不到活動或非 LINE 群發整批擋下', async () => {
  const ctx = buildHarness({ activity: { base_plays_per_user: 2 } });
  const ok = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: trackedMessage(), play_grant: { activityId: 9, plays: 1, mode: 'additive' }
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ctx.db.activity.base_plays_per_user, 2);
  assert.equal(ok.body.playGrant.basePlaysSetToZero, false);

  const missing = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: trackedMessage(), play_grant: { activityId: 404, plays: 1 }
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'play_grant_activity_not_found');

  const badPlays = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: trackedMessage(), play_grant: { activityId: 9, plays: 0 }
  });
  assert.equal(badPlays.statusCode, 400);
  assert.equal(badPlays.body.error, 'play_grant_plays_out_of_range');
  assert.equal(Object.keys(ctx.db.broadcasts).length, 1, '被擋下的請求不可建立批次');
});

test('只有 LINE 回報送達成功的人入帳；失敗的人沒有次數；重跑 chunk 不重複入帳', async () => {
  const ctx = buildHarness({ pushResults: { [UID(2)]: false } });
  const created = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true },
    message_config: trackedMessage(), play_grant: { activityId: 9, plays: 2, mode: 'additive' }
  });
  const broadcastId = created.body.broadcastId;
  const chunk = await runRoute(ctx.routes['POST /admin/broadcast/:id/process-chunk'], { chunkSize: 50 }, { id: String(broadcastId) });
  assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body));
  assert.equal(chunk.body.ok_count, 2);
  assert.equal(chunk.body.fail, 1);
  assert.equal(ctx.db.bonus.length, 2);
  const grantedIds = ctx.db.bonus.map(b => b.line_user_id).sort();
  assert.deepEqual(grantedIds, [UID(1), UID(3)]);
  assert.ok(ctx.db.bonus.every(b => b.plays === 2 && b.activity_id === 9));
  assert.ok(ctx.db.bonus.every(b => b.granted_key === grantedKey(broadcastId, 9, b.line_user_id)));
  assert.match(ctx.db.bonus[0].reason, /群發派送（批次 #/);

  // 失敗的人重設回 pending（resend-failed 的語意）再送一次成功：只補入帳他，其他人不重複
  ctx.db.recipients.filter(r => r.status === 'failed').forEach(r => { r.status = 'pending'; });
  ctx.db.broadcasts[broadcastId].status = 'running';
  ctx.pushResults[UID(2)] = true;
  const second = await runRoute(ctx.routes['POST /admin/broadcast/:id/process-chunk'], { chunkSize: 50 }, { id: String(broadcastId) });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.ok_count, 1);
  assert.equal(ctx.db.bonus.length, 3);
  assert.deepEqual(ctx.db.bonus.map(b => b.line_user_id).sort(), [UID(1), UID(2), UID(3)]);
});

test('沒有派送設定的批次送達後不會寫任何 bonus plays', async () => {
  const ctx = buildHarness();
  const created = await runRoute(ctx.routes['POST /admin/broadcast/create'], {
    channel: 'line', send_mode: 'immediate', conditions: { allMembers: true }, message_config: trackedMessage()
  });
  await runRoute(ctx.routes['POST /admin/broadcast/:id/process-chunk'], { chunkSize: 50 }, { id: String(created.body.broadcastId) });
  assert.equal(ctx.db.bonus.length, 0);
  assert.equal(ctx.calls.pushes.length, 3);
});

test('後台頁面、前端與批次詳情都接上派送設定', () => {
  const view = fs.readFileSync(path.join(REPO, 'views/admin_broadcast.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(REPO, 'public/admin-broadcast.js'), 'utf8');
  const route = fs.readFileSync(path.join(REPO, 'src/routes/adminBroadcast.js'), 'utf8');
  const detail = fs.readFileSync(path.join(REPO, 'views/admin_broadcast_detail.ejs'), 'utf8');
  const editor = fs.readFileSync(path.join(REPO, 'views/admin_activity_edit.ejs'), 'utf8');

  assert.match(view, /id="pg-enabled"/);
  assert.match(view, /id="pg-activity"/);
  assert.match(view, /id="pg-plays"/);
  assert.match(view, /name="pg-mode" value="exclusive"/);
  assert.match(view, /id="sc-playgrant-row"/);
  assert.match(script, /createBody\.play_grant = playGrant/);
  assert.match(script, /function validatePlayGrant/);
  assert.match(script, /prefillActivityId/);
  assert.match(route, /grantPlaysForRecipient\(query, \{ broadcastId, grant: playGrant/);
  assert.match(route, /grantPlaysForRecipient\(query, \{ broadcastId: row\.id/);
  assert.match(route, /playGrant: \(source\.audience_config \|\| \{\}\)\.playGrant/);
  assert.match(detail, /派送遊玩機會/);
  assert.match(editor, /\/admin\/broadcast\?activity_id=/);
  assert.match(editor, /id="ae-base-plays" min="0"/);
});
