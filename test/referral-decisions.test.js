const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, repairReferral, DECISION_SQL } = require('../src/core/referralDecisions');
const now = Date.parse('2026-10-05T10:00:00Z');
const activity = { id: 6, slug: 'fixture', game_type: 'wheel', status: 'active',
  start_at: '2026-09-01T00:00:00Z', end_at: '2026-11-01T00:00:00Z',
  referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1 };
const base = { inviter_uid: 'U'+'a'.repeat(32), invitee_uid: 'U'+'b'.repeat(32),
  inviter_valid: true, invitee_valid: true, current_new_friends: 0,
  first_seen_at: '2026-10-05T09:00:02Z', followed_at: '2026-10-05T09:00:02Z',
  proof_at: '2026-10-05T09:00:00Z', is_unblocked: 'false' };

test('完整旅程／首次加好友證據才可修正，不以 30 分鐘接近猜測', () => {
  assert.equal(assess(base, activity, now).extra_chances, 1);
  assert.equal(assess(base, activity, now).repairable, true);
  for (const change of [{ proof_at: null }, { is_unblocked: null }, { first_seen_at: null },
    { competing_inviter: true }, { invitee_valid: false }, { inviter_valid: false },
    { first_seen_at: '2026-10-05T08:00:00Z' }, { has_manual_bonus: true }, { has_override: true }]) {
    const d = assess({ ...base, ...change }, activity, now);
    assert.equal(d.decision, 'insufficient'); assert.equal(d.repairable, false);
  }
});
test('已入帳、既有好友、解除封鎖、其他邀請人與自邀均不補', () => {
  for (const change of [{ referral_id: 1, was_existing: false }, { is_unblocked: 'true' },
    { prior_friend_evidence: true }, { recorded_inviter: 'someone_else' },
    { invitee_uid: base.inviter_uid }]) {
    assert.equal(assess({ ...base, ...change }, activity, now).decision, 'no_action');
  }
});
test('活動時間、72h、有未來事件、結束狀態與特殊 MGM 保持 fail closed', () => {
  for (const change of [{ proof_at: '2026-08-31T23:59:59Z' },
    { proof_at: '2026-10-01T00:00:00Z' }, { followed_at: '2026-10-06T00:00:00Z' }])
    assert.equal(assess({ ...base, ...change }, activity, now).repairable, false);
  assert.equal(assess(base, { ...activity, status: 'ended' }, now).repairable, false);
  assert.equal(assess(base, { ...activity, game_type: 'mgm' }, now).decision, 'insufficient');
});
test('沿用共用配額：上限仍生效、邀兩位才一份的門檻不被繞過', () => {
  assert.equal(assess({ ...base, current_new_friends: 3 }, activity, now).extra_chances, 0);
  assert.equal(assess(base, { ...activity, referral_invites_per_bonus: 2 }, now).extra_chances, 0);
  assert.equal(assess({ ...base, current_new_friends: 1 },
    { ...activity, referral_invites_per_bonus: 2 }, now).extra_chances, 1);
});
test('修正交易留下操作者、重查證據，任何失敗都 rollback 並釋放連線', async () => {
  const commands = []; let released = false;
  const client = { query: async (sql, p) => {
    commands.push([sql,p]);
    if (sql.startsWith('SELECT * FROM activities')) return { rows: [{ ...activity,
      start_at: null, end_at: null }] };
    if (sql === DECISION_SQL) return { rows: [{ ...base, proof_at: new Date(Date.now()-5000),
      first_seen_at: new Date(Date.now()-3000), followed_at: new Date(Date.now()-3000) }] };
    if (sql.startsWith('INSERT INTO activity_referrals')) return { rows: [{ id: 1 }] };
    if (sql.startsWith('INSERT INTO activity_referral_attempts')) throw new Error('audit_failed');
    return { rows: [] };
  }, release: () => { released=true; } };
  await assert.rejects(repairReferral({ connect: async () => client }, 6,
    base.inviter_uid, base.invitee_uid, 'fixture-admin'), /audit_failed/);
  assert.equal(released,true);
  assert.equal(commands.at(-1)[0], 'ROLLBACK');
  assert.ok(!commands.some(([sql]) => sql === 'COMMIT'));
  assert.equal(commands.find(([sql]) => sql.startsWith('INSERT INTO activity_referral_attempts'))[1][4],
    'admin_reconciled:fixture-admin');
});
test('重複補發與無證據禁止寫入；SQL 查詢綁定活動、遊戲、邀請人及身分', async () => {
  const commands=[];
  const client={query:async (sql)=>{commands.push(sql);return {rows:sql.startsWith('SELECT * FROM activities')?[activity]:
    sql===DECISION_SQL?[{...base,referral_id:12,was_existing:false}]:[]};},release(){}};
  await assert.rejects(repairReferral({connect:async()=>client},6,base.inviter_uid,base.invitee_uid,'admin'),/not_repairable/);
  assert.ok(!commands.some(sql=>sql.startsWith('UPDATE')||sql.startsWith('INSERT')));
  assert.match(DECISION_SQL,/activity_slug=\$2 AND game_type=\$3/);
  assert.match(DECISION_SQL,/t\.inviter_line_user_id=p\.inviter_uid/);
});
