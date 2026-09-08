const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MAX_RECIPIENTS_PER_BROADCAST,
  parseExplicitLineUserIds,
  normalizeConditions,
  hasAnyCondition,
  previewAudience,
  fetchAudienceRecipients
} = require('../src/core/broadcastAudience');

const uid = ch => 'U' + ch.repeat(32);

test('直接貼 LINE ID 會驗證格式、去重並成為獨立受眾', () => {
  const parsed = parseExplicitLineUserIds([uid('a'), uid('A'), 'bad', '', uid('b')]);
  assert.deepEqual(parsed.values, [uid('a'), uid('b')]);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.invalid, 1);
  const conditions = normalizeConditions({ lineUserIds: parsed.values });
  assert.deepEqual(conditions.lineUserIds, [uid('a'), uid('b')]);
  assert.equal(hasAnyCondition(conditions), true);
});

test('預覽直接 ID 時保留 CRM 未知用戶，並排除已知封鎖或封存帳號', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 2 }] };
    return { rows: [
      { id: 1, line_user_id: uid('a'), line_display_name: '已知會員', username: null },
      { id: 3, line_user_id: uid('c'), line_display_name: null, username: null }
    ] };
  };
  const out = await previewAudience(query, { lineUserIds: [uid('a'), uid('b'), uid('c')] });
  assert.equal(out.total, 2);
  assert.equal(out.inputStats.excludedKnownUnavailable, 1);
  assert.deepEqual(calls[0].params[0], [uid('a'), uid('b'), uid('c')]);
  assert.match(calls[0].sql, /u\.id IS NULL OR \(u\.blocked_at IS NULL AND u\.archived_at IS NULL\)/);
  assert.equal(out.sample[1].line_user_id, uid('c'));
});

test('建立批次時直接使用貼上的 ID，不要求 users 表已有會員', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    return { rows: [
      { user_id: 91, line_user_id: uid('a') },
      { user_id: null, line_user_id: uid('c') }
    ] };
  };
  const out = await fetchAudienceRecipients(query, { lineUserIds: [uid('a'), uid('c')] });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[1].user_id, null);
  assert.match(calls[0].sql, /unnest\(\$1::text\[\]\) WITH ORDINALITY/);
  assert.deepEqual(calls[0].params[0], [uid('a'), uid('c')]);
});

test('直接貼上的收件人超過單批上限會明確擋下', async () => {
  const ids = Array.from({ length: MAX_RECIPIENTS_PER_BROADCAST + 1 }, (_, i) =>
    'U' + i.toString(16).padStart(32, '0'));
  let queried = false;
  const out = await previewAudience(async () => { queried = true; return { rows: [] }; }, { lineUserIds: ids });
  assert.match(out.error, /最多可推播 5000/);
  assert.equal(queried, false);
});

test('建立收件人資料時超過單批上限也會擋下，不會只取前 5000 人', async () => {
  const ids = Array.from({ length: MAX_RECIPIENTS_PER_BROADCAST + 1 }, (_, i) =>
    'U' + i.toString(16).padStart(32, '0'));
  let queried = false;
  const out = await fetchAudienceRecipients(async () => { queried = true; return { rows: [] }; }, { lineUserIds: ids });
  assert.match(out.error, /最多可推播 5000/);
  assert.equal(out.rows.length, 0);
  assert.equal(queried, false);
});

test('群發頁明確提供不必先存名單的 LINE ID 推播入口', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views/admin_broadcast.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public/admin-broadcast.js'), 'utf8');
  assert.match(view, /貼 LINE User ID/);
  assert.match(view, /不必先建立會員，也不必先存成名單/);
  assert.match(view, /另外存進名單庫/);
  assert.match(script, /lineUserIds: parseUidsFromText/);
  assert.match(script, /名單已變更，請重新預覽/);
  assert.match(script, /data\.detail \|\| data\.error/);
});
