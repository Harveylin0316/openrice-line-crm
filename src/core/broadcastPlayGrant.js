'use strict';
/**
 * 群發派送遊玩機會（play grant）
 *
 * 一則 LINE 群發可以附帶「收到的人可以玩指定活動 N 次」。設定存在
 * admin_broadcasts.audience_config.playGrant，不需要新資料表：
 *
 *   { activityId, activitySlug, activityName, gameType, plays, mode }
 *   mode = 'exclusive'  只有收到訊息的人能玩：建立批次時把活動基礎次數改成 0
 *   mode = 'additive'   加在活動原本的次數上
 *
 * 入帳時機：LINE 回報送達成功（recipient status = 'sent'）那一刻，寫一筆
 * activity_bonus_plays，granted_key = broadcast:<批次id>:<活動id>:<userId>。
 * 同一批次同一個人只會入帳一次；排程重跑、chunk 重試、resend-failed 都不會重複給。
 * 失敗／封鎖／略過的人不入帳。
 *
 * 次數本身仍由 gamePlayEngine.computeUserQuota() 統一計算（manualBonus），
 * 這裡不重算次數，也不直接動 activity_plays。
 */

const PLAY_GRANT_MIN = 1;
const PLAY_GRANT_MAX = 100;
const GRANT_MODES = ['exclusive', 'additive'];
const GRANTABLE_GAME_TYPES = ['scratch', 'wheel', 'fortune', 'slot', 'claim'];

function grantedKey(broadcastId, activityId, lineUserId) {
  return `broadcast:${Number(broadcastId)}:${Number(activityId)}:${String(lineUserId)}`;
}

/**
 * 正規化前端送來的 play_grant。回 { ok, value } 或 { ok:false, error }。
 * value 為 null 代表這則群發沒有派送次數。
 */
function normalizePlayGrant(raw) {
  if (raw == null || raw === false || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_play_grant' };
  if (raw.enabled === false) return { ok: true, value: null };
  const activityId = Number(raw.activityId != null ? raw.activityId : raw.activity_id);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    return { ok: false, error: 'play_grant_activity_required' };
  }
  const playsRaw = Number(raw.plays);
  if (!Number.isInteger(playsRaw) || playsRaw < PLAY_GRANT_MIN || playsRaw > PLAY_GRANT_MAX) {
    return { ok: false, error: 'play_grant_plays_out_of_range' };
  }
  const mode = String(raw.mode || 'additive');
  if (!GRANT_MODES.includes(mode)) return { ok: false, error: 'play_grant_mode_invalid' };
  return { ok: true, value: { activityId, plays: playsRaw, mode } };
}

/** 把 normalize 後的設定補上活動快照（slug／名稱／類型），並驗證活動可派送。 */
async function resolvePlayGrant(query, grant) {
  if (!grant) return { ok: true, value: null };
  const { rows } = await query(
    `SELECT id, slug, name, game_type, status, base_plays_per_user
       FROM activities WHERE id = $1 LIMIT 1`,
    [grant.activityId]
  );
  if (rows.length === 0) return { ok: false, error: 'play_grant_activity_not_found' };
  const a = rows[0];
  if (!GRANTABLE_GAME_TYPES.includes(String(a.game_type))) {
    return { ok: false, error: 'play_grant_activity_type_unsupported' };
  }
  return {
    ok: true,
    value: {
      activityId: Number(a.id),
      activitySlug: String(a.slug),
      activityName: String(a.name || ''),
      gameType: String(a.game_type),
      plays: grant.plays,
      mode: grant.mode,
      previousBasePlays: a.base_plays_per_user == null ? null : Number(a.base_plays_per_user)
    }
  };
}

/** 從 admin_broadcasts 列讀出 playGrant；沒有或格式不對就回 null。 */
function getPlayGrant(broadcastRow) {
  const cfg = broadcastRow && broadcastRow.audience_config;
  const obj = cfg && typeof cfg === 'object' ? cfg : null;
  const g = obj && obj.playGrant && typeof obj.playGrant === 'object' ? obj.playGrant : null;
  if (!g) return null;
  const activityId = Number(g.activityId);
  const plays = Number(g.plays);
  if (!Number.isInteger(activityId) || activityId <= 0) return null;
  if (!Number.isInteger(plays) || plays < PLAY_GRANT_MIN) return null;
  return {
    activityId,
    activitySlug: g.activitySlug ? String(g.activitySlug) : null,
    activityName: g.activityName ? String(g.activityName) : null,
    gameType: g.gameType ? String(g.gameType) : null,
    plays: Math.min(PLAY_GRANT_MAX, plays),
    mode: GRANT_MODES.includes(g.mode) ? g.mode : 'additive'
  };
}

/**
 * exclusive 模式：把活動基礎次數改成 0。在建立批次的同一個交易裡呼叫，
 * 只改 base_plays_per_user，rules／獎品／邀請設定都不動。
 */
async function applyExclusiveMode(client, grant) {
  if (!grant || grant.mode !== 'exclusive') return false;
  const rs = await client.query(
    `UPDATE activities SET base_plays_per_user = 0
      WHERE id = $1 AND COALESCE(base_plays_per_user, 1) <> 0`,
    [grant.activityId]
  );
  return rs.rowCount > 0;
}

/**
 * 送達成功後入帳。冪等：同一個 granted_key 只會存在一筆。
 * 回傳 true = 這次真的新增了一筆；false = 早就給過（或沒有 LINE ID）。
 */
async function grantPlaysForRecipient(query, { broadcastId, grant, lineUserId }) {
  if (!grant) return false;
  const uid = String(lineUserId || '').trim();
  if (!/^U[0-9a-f]{32}$/i.test(uid)) return false;
  const key = grantedKey(broadcastId, grant.activityId, uid);
  const reason = `群發派送（批次 #${Number(broadcastId)}）`;
  const rs = await query(
    `INSERT INTO activity_bonus_plays (activity_id, line_user_id, plays, reason, granted_key)
     SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM activity_bonus_plays WHERE granted_key = $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [grant.activityId, uid, grant.plays, reason, key]
  );
  return rs.rowCount > 0;
}

/**
 * 批次詳情用的派送成效：入帳人數、次數，以及這些人在該活動實際玩了幾次。
 */
async function loadPlayGrantSummary(query, broadcastId, grant) {
  if (!grant) return null;
  const prefix = `broadcast:${Number(broadcastId)}:${Number(grant.activityId)}:`;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS granted_users,
            COALESCE(SUM(b.plays), 0)::int AS granted_plays,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM activity_plays p
               WHERE p.activity_id = b.activity_id
                 AND p.line_user_id = b.line_user_id
                 AND p.played_at >= b.created_at
            ))::int AS users_played,
            COALESCE(SUM((
              SELECT COUNT(*) FROM activity_plays p
               WHERE p.activity_id = b.activity_id
                 AND p.line_user_id = b.line_user_id
                 AND p.played_at >= b.created_at
                 AND COALESCE(p.prize_snapshot->>'kind', '') <> 'draw_win'
            )), 0)::int AS plays_used
       FROM activity_bonus_plays b
      WHERE b.activity_id = $1 AND b.granted_key LIKE $2`,
    [grant.activityId, prefix + '%']
  );
  const r = rows[0] || {};
  return {
    activityId: grant.activityId,
    activitySlug: grant.activitySlug,
    activityName: grant.activityName,
    gameType: grant.gameType,
    plays: grant.plays,
    mode: grant.mode,
    grantedUsers: Number(r.granted_users || 0),
    grantedPlays: Number(r.granted_plays || 0),
    usersPlayed: Number(r.users_played || 0),
    playsUsed: Number(r.plays_used || 0)
  };
}

/** 給活動玩家數據頁：這個活動透過群發派送過幾批、幾人、幾次。 */
async function loadActivityGrantStats(query, activityId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS granted_users,
            COALESCE(SUM(plays), 0)::int AS granted_plays,
            COUNT(DISTINCT split_part(granted_key, ':', 2))::int AS broadcasts
       FROM activity_bonus_plays
      WHERE activity_id = $1 AND granted_key LIKE 'broadcast:%'`,
    [Number(activityId)]
  );
  const r = rows[0] || {};
  return {
    grantedUsers: Number(r.granted_users || 0),
    grantedPlays: Number(r.granted_plays || 0),
    broadcasts: Number(r.broadcasts || 0)
  };
}

module.exports = {
  PLAY_GRANT_MIN,
  PLAY_GRANT_MAX,
  GRANT_MODES,
  GRANTABLE_GAME_TYPES,
  grantedKey,
  normalizePlayGrant,
  resolvePlayGrant,
  getPlayGrant,
  applyExclusiveMode,
  grantPlaysForRecipient,
  loadPlayGrantSummary,
  loadActivityGrantStats
};
