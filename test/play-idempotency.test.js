// 防重複扣次數：同一把鑰匙重送 → 回原結果、不重複寫紀錄、不重複扣庫存。
const path = require('path');
const { selectPrizeAndRecord } = require(path.join(__dirname, '..', 'src/core/gamePlayEngine'));

let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

function makePool(state) {
  const handle = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    state.calls.push({ f, params });
    if (/SELECT id, status, start_at, end_at/.test(f))
      return { rows: [{ id: 6, status: 'active', start_at: null, end_at: null,
        daily_plays_per_user: null, base_plays_per_user: 5, referral_bonus_per: 0,
        referral_bonus_max: 0, referral_invites_per_bonus: 1 }] };
    if (/JOIN activities a2 ON/.test(f))
      return { rows: [{ id: 77, prize_id: 15, coupon_code: 'OLD-123',
        prize_snapshot: { name: 'Rice Dollar $30', prize_type: 'coupon_code', position: 4, prize_value: {} } }] };
    if (/properties->>'play_key' = \$3/.test(f)) {
      if (state.dupKey && params[2] === state.dupKey)
        return { rows: [{ id: 77, prize_id: 15, coupon_code: 'OLD-123',
          prize_snapshot: { name: 'Rice Dollar $30', description: '', position: 4,
            prize_type: 'coupon_code', prize_value: {}, is_grand_prize: false } }] };
      return { rows: [] };
    }
    if (/activity_user_quotas/.test(f)) return { rows: [] };
    if (/COUNT\(\*\) AS c FROM activity_plays/.test(f)) return { rows: [{ c: 0 }] };
    if (/FROM activity_referrals/.test(f)) return { rows: [{ c: 0, existing: 0 }] };
    if (/activity_bonus_plays/.test(f)) return { rows: [{ b: 0 }] };
    if (/FROM activity_prizes/.test(f))
      return { rows: [{ id: 15, name: 'Rice Dollar $30', description: '', probability_weight: 1,
        stock_total: 10, stock_remaining: 10, prize_type: 'badge', prize_value: {},
        image_url: null, is_grand_prize: false, position: 4 }] };
    if (/INSERT INTO activity_plays/.test(f)) {
      if (state.insertConflicts) {
        const e = new Error('duplicate key value violates unique constraint "uq_plays_play_key"');
        throw e;
      }
      state.inserts.push(params);
      return { rows: [{ id: 99, played_at: new Date().toISOString() }] };
    }
    if (/UPDATE activity_prizes/.test(f)) { state.stockUpdates++; return { rows: [] }; }
    if (/coupon_codes/.test(f)) return { rows: [] };
    return { rows: [] };
  };
  const client = { query: handle, release() {} };
  return { connect: async () => client, query: handle };
}

(async () => {
  // 1) 新鑰匙：正常抽、紀錄裡帶著鑰匙
  let st = { calls: [], inserts: [], stockUpdates: 0, dupKey: null };
  let r = await selectPrizeAndRecord({ pool: makePool(st), activitySlug: 'x', gameType: 'wheel',
    lineUserId: 'U1', lineDisplayName: 't', req: { headers: {} }, playKey: 'pknew12345' });
  ok(r.ok === true && !r.replayed, '新鑰匙正常抽');
  ok(st.inserts.length === 1 && String(st.inserts[0][5]).indexOf('pknew12345') >= 0, '鑰匙存進紀錄');

  // 2) 同一把鑰匙重送：回原結果、不寫新紀錄、不扣庫存
  st = { calls: [], inserts: [], stockUpdates: 0, dupKey: 'pkdup4567' };
  r = await selectPrizeAndRecord({ pool: makePool(st), activitySlug: 'x', gameType: 'wheel',
    lineUserId: 'U1', lineDisplayName: 't', req: { headers: {} }, playKey: 'pkdup4567' });
  ok(r.ok === true && r.replayed === true, '重送回原結果');
  ok(r.prize.id === 15 && r.prize.name === 'Rice Dollar $30' && r.coupon_code === 'OLD-123', '原本中的獎照樣給');
  ok(st.inserts.length === 0 && st.stockUpdates === 0, '沒有重複寫紀錄、沒有重複扣庫存');

  // 3) 極端併發撞唯一鍵：照樣回原結果
  st = { calls: [], inserts: [], stockUpdates: 0, dupKey: null, insertConflicts: true };
  r = await selectPrizeAndRecord({ pool: makePool(st), activitySlug: 'x', gameType: 'wheel',
    lineUserId: 'U1', lineDisplayName: 't', req: { headers: {} }, playKey: 'pkrace9999' });
  ok(r.ok === true && r.replayed === true, '併發撞鍵也回原結果，不是報錯');

  // 4) 沒帶鑰匙：一切照舊
  st = { calls: [], inserts: [], stockUpdates: 0, dupKey: null };
  r = await selectPrizeAndRecord({ pool: makePool(st), activitySlug: 'x', gameType: 'wheel',
    lineUserId: 'U1', lineDisplayName: 't', req: { headers: {} } });
  ok(r.ok === true && st.inserts.length === 1, '沒帶鑰匙照常運作（相容舊版前端）');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n防重複扣次數全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
