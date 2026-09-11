const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseIsoDate,
  validateJoinedDateRange,
  normalizeConditions,
  hasAnyCondition,
  previewAudience,
  fetchAudienceRecipients
} = require('../src/core/broadcastAudience');

test('自訂加入日期會嚴格驗證真實日期與先後順序', () => {
  assert.equal(parseIsoDate('2026-09-01'), '2026-09-01');
  assert.equal(parseIsoDate('2026-02-31'), null);
  assert.equal(parseIsoDate('09/01/2026'), null);
  assert.match(validateJoinedDateRange({ joinedFromDate: '2026-09-12', joinedToDate: '2026-09-01' }), /開始日不能晚於結束日/);
  assert.match(validateJoinedDateRange({ joinedFromDate: '2026-02-31' }), /開始日格式錯誤/);
  assert.match(validateJoinedDateRange({ joinedDateMode: 'custom' }), /至少選擇開始日或結束日/);
});

test('自訂日期優先於舊天數條件，且可只填單邊', () => {
  const fromOnly = normalizeConditions({ joinedWithinDays: 30, joinedFromDate: '2026-09-01' });
  assert.equal(fromOnly.joinedWithinDays, null);
  assert.equal(fromOnly.joinedFromDate, '2026-09-01');
  assert.equal(fromOnly.joinedToDate, null);
  assert.equal(hasAnyCondition(fromOnly), true);

  const toOnly = normalizeConditions({ joinedToDate: '2026-09-10' });
  assert.equal(toOnly.joinedToDate, '2026-09-10');
  assert.equal(hasAnyCondition(toOnly), true);
});

test('預覽與正式名單共用台灣時間且結束日包含整天', async () => {
  const previewCalls = [];
  const previewQuery = async (sql, params) => {
    previewCalls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params.slice() });
    if (/COUNT\(DISTINCT u\.id\)/.test(sql)) return { rows: [{ total: 2 }] };
    return { rows: [] };
  };
  const conditions = {
    allMembers: true,
    joinedFromDate: '2026-09-01',
    joinedToDate: '2026-09-10'
  };
  const preview = await previewAudience(previewQuery, conditions);
  assert.equal(preview.error, null);
  assert.equal(preview.total, 2);
  assert.deepEqual(previewCalls[0].params, ['2026-09-01', '2026-09-10']);
  assert.match(previewCalls[0].sql, /created_at >= \(\$1::date::timestamp AT TIME ZONE 'Asia\/Taipei'\)/);
  assert.match(previewCalls[0].sql, /created_at < \(\(\(\$2::date \+ 1\)::timestamp\) AT TIME ZONE 'Asia\/Taipei'\)/);

  const sendCalls = [];
  const send = await fetchAudienceRecipients(async (sql, params) => {
    sendCalls.push({ sql: String(sql).replace(/\s+/g, ' '), params: params.slice() });
    return { rows: [{ user_id: 1, line_user_id: 'U' + 'a'.repeat(32) }] };
  }, conditions);
  assert.equal(send.error, undefined);
  assert.deepEqual(sendCalls[0].params.slice(0, 2), previewCalls[0].params);
  assert.match(sendCalls[0].sql, /AT TIME ZONE 'Asia\/Taipei'/);
});

test('錯誤日期不查資料庫，也不建立正式名單', async () => {
  let queried = false;
  const query = async () => { queried = true; return { rows: [] }; };
  const raw = { allMembers: true, joinedFromDate: '2026-09-20', joinedToDate: '2026-09-01' };
  const preview = await previewAudience(query, raw);
  assert.match(preview.error, /開始日不能晚於結束日/);
  const send = await fetchAudienceRecipients(query, raw);
  assert.match(send.error, /開始日不能晚於結束日/);
  assert.equal(send.rows.length, 0);
  assert.equal(queried, false);
});

test('只有錯誤日期時也回明確錯誤，不會被當成一般未選條件', async () => {
  let queried = false;
  const out = await previewAudience(async () => { queried = true; return { rows: [] }; }, {
    joinedDateMode: 'custom',
    joinedFromDate: '2026-02-31'
  });
  assert.match(out.error, /開始日格式錯誤/);
  assert.equal(queried, false);
});

test('群發頁提供自訂日期 UI、前端檢核與預覽失效機制', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views/admin_broadcast.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public/admin-broadcast.js'), 'utf8');
  assert.match(view, /<option value="custom">自訂日期範圍<\/option>/);
  assert.match(view, /id="joined-from-date"/);
  assert.match(view, /id="joined-to-date"/);
  assert.match(view, /結束日包含當天/);
  assert.match(script, /validateJoinedDateSelection/);
  assert.match(script, /joinedFromDate: joinedFromDate/);
  assert.match(script, /fromEl\.addEventListener\('change', invalidateAudiencePreview\)/);
});
