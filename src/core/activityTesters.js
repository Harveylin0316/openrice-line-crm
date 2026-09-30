'use strict';
/**
 * 活動測試帳號：讓管理者用「測試人員」名單上的 LINE 帳號，把一檔活動從
 * 新戶加入 → 開始玩 → 分享 → 邀請成功 → 拿到加碼次數 整條路走無限次。
 *
 * 測試人員名單就是群發「測試人員」那一份（admin_test_recipients），不另開名單。
 *
 * 兩個機制：
 * 1) 重置（resetTesterInActivity）：把該測試帳號在這一檔活動的一切清掉，回到全新狀態：
 *    抽獎紀錄、加碼次數（人工補次／群發派送）、個別配額、邀請紀錄（當邀請人與被邀請人都清）、
 *    邀請嘗試紀錄、開啟／開始／完成／分享事件。
 *    抽獎佔用的實體／虛擬獎品庫存會還回去；優惠序號不還（序號是真的字串、可能已被看到或使用），
 *    只回報用掉幾組。不動 users 會員資料（不封存、不改加入時間），不影響其他人。
 * 2) 新好友判定（isTesterPair）：邀請人與被邀請人「都」在測試人員名單上時，
 *    被邀請人一律視為新好友（invitee_was_existing = false）。真實用戶的邀請完全不受影響，
 *    測試帳號去點真實用戶的連結也照一般規則判定，不會替真實用戶灌加碼。
 */

const UID_RE = /^U[0-9a-f]{32}$/i;

async function listTesters(query) {
  const { rows } = await query(
    `SELECT id, label, line_user_id FROM admin_test_recipients ORDER BY id ASC`
  );
  return rows
    .map(r => ({ id: Number(r.id), label: String(r.label || '').trim(), line_user_id: String(r.line_user_id || '').trim() }))
    .filter(r => UID_RE.test(r.line_user_id));
}

async function isTester(query, lineUserId) {
  if (!UID_RE.test(String(lineUserId || ''))) return false;
  const { rows } = await query(
    `SELECT 1 FROM admin_test_recipients WHERE line_user_id = $1 LIMIT 1`,
    [String(lineUserId)]
  );
  return rows.length > 0;
}

/** 邀請人與被邀請人都在測試人員名單上 */
async function isTesterPair(query, inviterId, inviteeId) {
  if (!UID_RE.test(String(inviterId || '')) || !UID_RE.test(String(inviteeId || ''))) return false;
  if (inviterId === inviteeId) return false;
  const { rows } = await query(
    `SELECT COUNT(DISTINCT line_user_id)::int AS n
       FROM admin_test_recipients
      WHERE line_user_id = ANY($1::text[])`,
    [[String(inviterId), String(inviteeId)]]
  );
  return Number(rows[0] && rows[0].n) === 2;
}

/** 每位測試帳號在這檔活動的現況（後台列表用） */
async function testerProgress(query, activityId, testers) {
  const uids = testers.map(t => t.line_user_id);
  if (uids.length === 0) return [];
  const { rows } = await query(
    `SELECT t.uid AS line_user_id,
            (SELECT COUNT(*) FROM activity_plays p
              WHERE p.activity_id = $1 AND p.line_user_id = t.uid
                AND COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win')::int AS plays,
            (SELECT COUNT(*) FROM activity_referrals r
              WHERE r.activity_id = $1 AND r.inviter_line_user_id = t.uid
                AND r.invitee_was_existing IS FALSE)::int AS new_friend_invites,
            (SELECT COUNT(*) FROM activity_referrals r
              WHERE r.activity_id = $1 AND r.invitee_line_user_id = t.uid)::int AS invited_by_count,
            (SELECT COALESCE(SUM(b.plays), 0) FROM activity_bonus_plays b
              WHERE b.activity_id = $1 AND b.line_user_id = t.uid)::int AS bonus_plays,
            (SELECT MAX(e.created_at) FROM activity_user_events e
              WHERE e.activity_id = $1 AND e.line_user_id = t.uid) AS last_seen_at
       FROM UNNEST($2::text[]) AS t(uid)`,
    [Number(activityId), uids]
  );
  const by = {};
  rows.forEach(r => { by[r.line_user_id] = r; });
  return testers.map(t => {
    const r = by[t.line_user_id] || {};
    return {
      label: t.label,
      line_user_id: t.line_user_id,
      plays: Number(r.plays || 0),
      new_friend_invites: Number(r.new_friend_invites || 0),
      invited_by_count: Number(r.invited_by_count || 0),
      bonus_plays: Number(r.bonus_plays || 0),
      last_seen_at: r.last_seen_at || null
    };
  });
}

/**
 * 重置單一測試帳號在一檔活動的進度。整個在同一個交易裡做，任何一步失敗就全部回滾。
 * 不在測試人員名單上的帳號一律拒絕（err.code = 'not_tester'），避免誤刪真實用戶資料。
 */
async function resetTesterInActivity(pool, activityId, lineUserId) {
  const uid = String(lineUserId || '').trim();
  if (!UID_RE.test(uid)) {
    const e = new Error('LINE ID 格式不對'); e.code = 'bad_uid'; throw e;
  }
  const aid = Number(activityId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(`SELECT 1 FROM admin_test_recipients WHERE line_user_id = $1 LIMIT 1`, [uid]);
    if (t.rows.length === 0) {
      const e = new Error('只能重置「測試人員」名單上的帳號'); e.code = 'not_tester'; throw e;
    }
    const act = await client.query(`SELECT id, slug, game_type FROM activities WHERE id = $1 LIMIT 1`, [aid]);
    if (act.rows.length === 0) {
      const e = new Error('找不到活動'); e.code = 'activity_not_found'; throw e;
    }
    const { slug, game_type: gameType } = act.rows[0];

    // 1) 還庫存：測試抽中的非序號獎品，把佔掉的庫存加回去（不超過總量）
    const restored = await client.query(
      `UPDATE activity_prizes pr
          SET stock_remaining = LEAST(pr.stock_total, pr.stock_remaining + x.n)
         FROM (SELECT prize_id, COUNT(*)::int AS n
                 FROM activity_plays
                WHERE activity_id = $1 AND line_user_id = $2 AND prize_id IS NOT NULL
                GROUP BY prize_id) x
        WHERE pr.id = x.prize_id
          AND pr.activity_id = $1
          AND pr.stock_total IS NOT NULL
          AND COALESCE(pr.prize_type, '') <> 'coupon_code'
        RETURNING pr.id, x.n`,
      [aid, uid]
    );
    // 2) 優惠序號不還，只回報用掉幾組
    const codes = await client.query(
      `SELECT COUNT(*)::int AS n FROM coupon_codes WHERE activity_id = $1 AND claimed_line_user_id = $2`,
      [aid, uid]
    ).catch(() => ({ rows: [{ n: 0 }] }));

    const del = async (sql, params) => (await client.query(sql, params)).rowCount;
    const cleared = {
      plays: await del(`DELETE FROM activity_plays WHERE activity_id = $1 AND line_user_id = $2`, [aid, uid]),
      bonus_plays: await del(`DELETE FROM activity_bonus_plays WHERE activity_id = $1 AND line_user_id = $2`, [aid, uid]),
      quota_override: await del(`DELETE FROM activity_user_quotas WHERE activity_id = $1 AND line_user_id = $2`, [aid, uid]),
      referrals: await del(
        `DELETE FROM activity_referrals WHERE activity_id = $1 AND (inviter_line_user_id = $2 OR invitee_line_user_id = $2)`,
        [aid, uid]
      ),
      referral_attempts: await del(
        `DELETE FROM activity_referral_attempts
          WHERE activity_slug = $1 AND game_type = $2 AND (inviter_line_user_id = $3 OR invitee_line_user_id = $3)`,
        [slug, gameType, uid]
      ),
      events: await del(`DELETE FROM activity_user_events WHERE activity_id = $1 AND line_user_id = $2`, [aid, uid])
    };
    await client.query('COMMIT');
    return {
      line_user_id: uid,
      cleared,
      stock_restored: restored.rows.reduce((s, r) => s + Number(r.n || 0), 0),
      coupon_codes_used: Number(codes.rows[0] && codes.rows[0].n || 0)
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listTesters, isTester, isTesterPair, testerProgress, resetTesterInActivity };
