/**
 * 群發訊息「收件人條件」查詢 builder
 *
 * 條件結構（JSON）：
 * {
 *   prizeFilter: {
 *     mode: 'any' | 'all' | 'none',     // 中過任一 / 中過全部 / 從未中過這些獎
 *     prizeNames: string[]               // 用 prize_name 字串比對（與 draw_logs 一致）
 *   } | null,
 *   inviteCompletedMin: number | null,  // 邀請成功 rewarded 數 ≥ N
 *   drewInCampaign: boolean | null,     // true = 活動期間刮過; false = 從未刮過
 *
 *   // 活動頁（好康地圖／擲骰子）行為條件
 *   playedLiffWithinDays: number | null,     // 最近 N 天內開過活動頁、或在裡面做過任何動作
 *   clickedBookingWithinDays: number | null, // 最近 N 天內點過訂位
 *   liffInactiveDays: number | null,         // 以前玩過活動頁、但最近 N 天都沒再來（沉睡玩家）
 *
 *   // 訂位來源（用戶在官方帳號選單回答「透過 OpenRice 訂位」「透過 Google 預訂」）
 *   bookingSource: string | null,            // 只發給最新一次回答是這個來源的人（例：'openrice'、'google'）
 *   bookingSourceAnswered: boolean | null    // true = 回答過的人; false = 從來沒回答過的人（可以再問一次）
 * }
 *
 * 共用過濾：line_user_id 非空、非管理員。
 */

const MAX_RECIPIENTS_PER_BROADCAST = 5000;
const PREVIEW_SAMPLE_LIMIT = 10;

// 活動頁行為資料來源：已把行為紀錄對應到會員的檢視（明碼與雜湊兩種 line_id 都涵蓋），
// 直接用它就好，不要自己去接原始行為表。
const LIFF_EVENTS_SOURCE = 'member_liff_events';
// 「點過訂位」對應的行為代號。
const LIFF_EVENT_BOOKING_CLICK = 'map_booking_click';

// 訂位來源資料來源：每個人只留「最新一次回答」的檢視，
// 所以一個人不會因為回答很多次而重複出現，也不必自己排序取最新。
const BOOKING_SOURCE_VIEW = 'member_booking_source';
// 來源代號的長度上限（與官方帳號那邊記錄時的上限一致）。
const BOOKING_SOURCE_MAX_LEN = 40;

// 訂位來源代號的共用寫法：去頭尾空白、轉小寫、拿掉中間所有空白，
// 太長或空白一律視為沒填（和記錄回答時的處理方式一致，才對得起來）。
function parseBookingSource(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (!key || key.length > BOOKING_SOURCE_MAX_LEN) return null;
  return key;
}

// 天數輸入的共用檢查：必須是 1 ~ 3650 的整數，否則視為沒填。
function parseDays(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : null;
}

// 生命週期階段門檻（天）— 與 flowEngine.runInactivityTriggers 的 last_activity 口徑一致。
const LIFECYCLE_NEW_DAYS = 14;       // 新客：加入 <= 14 天（優先判定）
const LIFECYCLE_ACTIVE_DAYS = 30;    // 活躍：last_activity <= 30 天（且非新客）
const LIFECYCLE_LOST_DAYS = 90;      // 流失：last_activity > 90 天；沉睡 = 30~90 天
const LIFECYCLE_STAGES = ['new', 'active', 'sleeping', 'lost'];

// 可重用的 last_activity SQL 片段（子查詢，以 u 為 alias，需可取得 u.id 與 u.line_user_id）。
// 口徑：GREATEST(加好友時間, 各互動表最後時間) — 與 flowEngine 完全相同。
// 活動頁那一項用 member_liff_events 以會員編號比對：舊寫法只比對明碼的 LINE 識別碼，
// 07-17 之後改成雜湊型態的紀錄會全部漏掉，導致這些人的最後活動時間偏舊、被誤判成沉睡。
const LAST_ACTIVITY_SQL = `GREATEST(
  u.created_at,
  (SELECT MAX(w.event_timestamp) FROM line_webhook_events w WHERE w.line_user_id = u.line_user_id),
  (SELECT MAX(p.played_at) FROM activity_plays p WHERE p.line_user_id = u.line_user_id),
  (SELECT MAX(b.clicked_at) FROM admin_broadcast_clicks b WHERE b.line_user_id = u.line_user_id),
  (SELECT MAX(rc.clicked_at) FROM user_restaurant_clicks rc WHERE rc.line_user_id = u.line_user_id),
  (SELECT MAX(mle.created_at) FROM ${LIFF_EVENTS_SOURCE} mle WHERE mle.user_id = u.id)
)`;

// 階段判定 SQL（回傳 'new' | 'active' | 'sleeping' | 'lost'），給 profile 查詢與篩選共用。
// 以 u 為 alias、需可取得 u.created_at。
const LIFECYCLE_STAGE_SQL = `CASE
  WHEN u.created_at >= now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day') THEN 'new'
  WHEN ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day') THEN 'active'
  WHEN ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day') THEN 'sleeping'
  ELSE 'lost'
END`;

// 產生「某用戶屬於指定階段集合」的 WHERE 片段（不含參數，門檻是常數）。
// stages：已驗證過的階段字串陣列（new/active/sleeping/lost）。
function lifecycleWhereSql(stages) {
  const clauses = [];
  if (stages.includes('new')) {
    clauses.push(`u.created_at >= now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')`);
  }
  if (stages.includes('active')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day'))`);
  }
  if (stages.includes('sleeping')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} < now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day'))`);
  }
  if (stages.includes('lost')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} < now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day'))`);
  }
  if (clauses.length === 0) return null;
  return '(' + clauses.join(' OR ') + ')';
}

function normalizeConditions(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const out = {
    allMembers: false,
    joinedWithinDays: null,
    lifecycleStages: null,
    prizeFilter: null,
    inviteCompletedMin: null,
    drewInCampaign: null,
    playedLiffWithinDays: null,
    clickedBookingWithinDays: null,
    liffInactiveDays: null,
    bookingSource: null,
    bookingSourceAnswered: null,
    savedListId: null
  };

  if (safe.allMembers === true || safe.allMembers === 'true') {
    out.allMembers = true;
  }

  // 生命週期階段（多選）：接受陣列或單一字串，過濾成合法集合
  if (safe.lifecycleStages != null) {
    const rawStages = Array.isArray(safe.lifecycleStages)
      ? safe.lifecycleStages
      : [safe.lifecycleStages];
    const stages = [...new Set(
      rawStages.map(s => String(s || '').trim().toLowerCase()).filter(s => LIFECYCLE_STAGES.includes(s))
    )];
    // 全選 4 個 = 等同不限，不套用條件
    if (stages.length > 0 && stages.length < LIFECYCLE_STAGES.length) {
      out.lifecycleStages = stages;
    }
  }

  out.joinedWithinDays = parseDays(safe.joinedWithinDays);

  // 活動頁行為條件（都是天數，沒填就維持 null、完全不影響原本的篩選結果）
  out.playedLiffWithinDays = parseDays(safe.playedLiffWithinDays);
  out.clickedBookingWithinDays = parseDays(safe.clickedBookingWithinDays);
  out.liffInactiveDays = parseDays(safe.liffInactiveDays);

  // 訂位來源（沒填或填了怪東西就維持 null，完全不影響原本的篩選結果）
  out.bookingSource = parseBookingSource(safe.bookingSource);
  if (safe.bookingSourceAnswered === true || safe.bookingSourceAnswered === 'true') {
    out.bookingSourceAnswered = true;
  } else if (safe.bookingSourceAnswered === false || safe.bookingSourceAnswered === 'false') {
    out.bookingSourceAnswered = false;
  }

  if (safe.prizeFilter && typeof safe.prizeFilter === 'object') {
    const mode = ['any', 'all', 'none'].includes(safe.prizeFilter.mode) ? safe.prizeFilter.mode : 'any';
    const prizeNames = Array.isArray(safe.prizeFilter.prizeNames)
      ? [...new Set(safe.prizeFilter.prizeNames.map(n => String(n || '').trim()).filter(Boolean))]
      : [];
    if (prizeNames.length > 0) {
      out.prizeFilter = { mode, prizeNames };
    }
  }

  const n = Number(safe.inviteCompletedMin);
  if (Number.isInteger(n) && n > 0 && n <= 1000) {
    out.inviteCompletedMin = n;
  }

  if (safe.drewInCampaign === true || safe.drewInCampaign === false) {
    out.drewInCampaign = safe.drewInCampaign;
  }

  const listId = Number(safe.savedListId);
  if (Number.isInteger(listId) && listId > 0) {
    out.savedListId = listId;
  }

  return out;
}

function hasAnyCondition(conds) {
  return Boolean(
    conds.allMembers ||
    conds.joinedWithinDays !== null ||
    conds.lifecycleStages ||
    conds.savedListId ||
    conds.prizeFilter ||
    conds.inviteCompletedMin !== null ||
    conds.drewInCampaign !== null ||
    conds.playedLiffWithinDays !== null ||
    conds.clickedBookingWithinDays !== null ||
    conds.liffInactiveDays !== null ||
    conds.bookingSource !== null ||
    conds.bookingSourceAnswered !== null
  );
}

function buildWhere(conds) {
  const params = [];
  const where = [
    'u.line_user_id IS NOT NULL',
    "BTRIM(u.line_user_id) <> ''",
    "u.is_admin = false",
    'u.blocked_at IS NULL',
    // 已封存＝屬於已停用的舊 OA，其 line_user_id 對現行 OA 無效（跨 provider 不通用），
    // 推播必定失敗，故一律排除於受眾之外。資料本身保留可查。
    'u.archived_at IS NULL'
  ];

  // allMembers = 全部會員（不套用其他行為條件，但加入時間仍可疊加）
  if (conds.joinedWithinDays !== null) {
    params.push(conds.joinedWithinDays);
    where.push(`u.created_at >= now() - ($${params.length}::int * interval '1 day')`);
  }
  // allMembers 為 true 時，跳過後面的行為條件（生命週期/prize/invite/drew）
  if (conds.allMembers) {
    return { whereSql: where.join(' AND '), params };
  }

  if (conds.lifecycleStages) {
    const lcSql = lifecycleWhereSql(conds.lifecycleStages);
    if (lcSql) where.push(lcSql);
  }

  if (conds.prizeFilter) {
    params.push(conds.prizeFilter.prizeNames);
    const p = `$${params.length}::text[]`;
    if (conds.prizeFilter.mode === 'any') {
      where.push(`EXISTS (
        SELECT 1 FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      )`);
    } else if (conds.prizeFilter.mode === 'all') {
      where.push(`(
        SELECT COUNT(DISTINCT d.prize_name) FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      ) = ${conds.prizeFilter.prizeNames.length}`);
    } else if (conds.prizeFilter.mode === 'none') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      )`);
    }
  }

  if (conds.inviteCompletedMin !== null) {
    params.push(conds.inviteCompletedMin);
    where.push(`(
      SELECT COUNT(*) FROM line_invites li
      WHERE li.inviter_user_id = u.id AND li.status = 'rewarded'
    ) >= $${params.length}`);
  }

  if (conds.drewInCampaign === true) {
    where.push(`EXISTS (SELECT 1 FROM draw_logs d WHERE d.user_id = u.id)`);
  } else if (conds.drewInCampaign === false) {
    where.push(`NOT EXISTS (SELECT 1 FROM draw_logs d WHERE d.user_id = u.id)`);
  }

  // 以下三個都用 EXISTS／NOT EXISTS 子查詢，一個人只會算一次，不會因為玩很多次就重複出現。

  // 最近 N 天內開過活動頁、或在活動頁裡做過任何動作
  if (conds.playedLiffWithinDays !== null) {
    params.push(conds.playedLiffWithinDays);
    where.push(`EXISTS (
      SELECT 1 FROM ${LIFF_EVENTS_SOURCE} le
      WHERE le.user_id = u.id
        AND le.created_at >= now() - ($${params.length}::int * interval '1 day')
    )`);
  }

  // 最近 N 天內點過訂位
  if (conds.clickedBookingWithinDays !== null) {
    params.push(LIFF_EVENT_BOOKING_CLICK);
    const bookingParam = `$${params.length}::text`;
    params.push(conds.clickedBookingWithinDays);
    where.push(`EXISTS (
      SELECT 1 FROM ${LIFF_EVENTS_SOURCE} le
      WHERE le.user_id = u.id
        AND le.event_name = ${bookingParam}
        AND le.created_at >= now() - ($${params.length}::int * interval '1 day')
    )`);
  }

  // 沉睡玩家：以前玩過活動頁，但最近 N 天都沒再來
  if (conds.liffInactiveDays !== null) {
    params.push(conds.liffInactiveDays);
    where.push(`(
      EXISTS (
        SELECT 1 FROM ${LIFF_EVENTS_SOURCE} le
        WHERE le.user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${LIFF_EVENTS_SOURCE} le
        WHERE le.user_id = u.id
          AND le.created_at >= now() - ($${params.length}::int * interval '1 day')
      )
    )`);
  }

  // 訂位來源：只看每個人「最新一次」的回答（member_booking_source 每人只留最新一筆，
  // 所以同一個人不會因為回答過很多次而重複出現）。
  if (conds.bookingSource !== null) {
    params.push(conds.bookingSource);
    where.push(`EXISTS (
      SELECT 1 FROM ${BOOKING_SOURCE_VIEW} bs
      WHERE bs.line_user_id = u.line_user_id
        AND bs.source_key = $${params.length}::text
    )`);
  }

  // 有沒有回答過訂位來源：true = 回答過任何一種; false = 從來沒回答過（可以再問一次）
  if (conds.bookingSourceAnswered === true) {
    where.push(`EXISTS (
      SELECT 1 FROM ${BOOKING_SOURCE_VIEW} bs
      WHERE bs.line_user_id = u.line_user_id
    )`);
  } else if (conds.bookingSourceAnswered === false) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM ${BOOKING_SOURCE_VIEW} bs
      WHERE bs.line_user_id = u.line_user_id
    )`);
  }

  return { whereSql: where.join(' AND '), params };
}

async function previewAudience(query, rawConditions, { channel = 'line' } = {}) {
  const conds = normalizeConditions(rawConditions);
  // channel=email 時：條件式 audience 不適用（users 表沒 email），只能用 savedListId
  if (channel === 'email') {
    if (!conds.savedListId) {
      return { total: 0, sample: [], conditions: conds, error: 'Email 通道請選一份名單（需含 email 欄位）。' };
    }
    const UNSUB = `AND NOT EXISTS (SELECT 1 FROM admin_email_unsubscribes ue WHERE LOWER(ue.email) = LOWER(BTRIM(m.email)))`;
    const total = await query(
      `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> '' ${UNSUB}`,
      [conds.savedListId]
    );
    const sampleRs = await query(
      `SELECT m.id, m.email, m.display_name
       FROM admin_recipient_list_members m
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> '' ${UNSUB}
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, PREVIEW_SAMPLE_LIMIT]
    );
    return {
      total: Number(total.rows[0]?.n || 0),
      sample: sampleRs.rows,
      conditions: conds,
      error: null
    };
  }
  if (!hasAnyCondition(conds)) {
    return { total: 0, sample: [], conditions: conds, error: '請至少選一個條件或選擇一份名單。' };
  }
  // 來源：已儲存名單
  if (conds.savedListId) {
    // LINE 通道：只算有 line_user_id 的成員（email-only 成員不能用 LINE 發），並排除已封鎖
    const LINE_FILTER = `AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> '' AND (u.blocked_at IS NULL OR u.id IS NULL) AND (u.archived_at IS NULL OR u.id IS NULL)`;
    const total = await query(
      `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 ${LINE_FILTER}`,
      [conds.savedListId]
    );
    const sampleRs = await query(
      `SELECT m.id, m.line_user_id, u.line_display_name, u.username
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 ${LINE_FILTER}
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, PREVIEW_SAMPLE_LIMIT]
    );
    return {
      total: Number(total.rows[0]?.n || 0),
      sample: sampleRs.rows,
      conditions: conds,
      error: null
    };
  }
  // 來源：條件篩選
  const { whereSql, params } = buildWhere(conds);
  const countSql = `SELECT COUNT(DISTINCT u.id) AS total FROM users u WHERE ${whereSql}`;
  const sampleParams = params.slice();
  sampleParams.push(PREVIEW_SAMPLE_LIMIT);
  const sampleSql = `
    SELECT u.id, u.line_user_id, u.line_display_name, u.username
    FROM users u
    WHERE ${whereSql}
    ORDER BY u.id ASC
    LIMIT $${sampleParams.length}
  `;
  const [c, s] = await Promise.all([query(countSql, params), query(sampleSql, sampleParams)]);
  return {
    total: Number(c.rows[0]?.total || 0),
    sample: s.rows,
    conditions: conds,
    error: null
  };
}

async function fetchAudienceRecipients(query, rawConditions, { limit = MAX_RECIPIENTS_PER_BROADCAST, channel = 'line' } = {}) {
  const conds = normalizeConditions(rawConditions);
  const cappedLimit = Math.min(Math.max(1, Number(limit) || MAX_RECIPIENTS_PER_BROADCAST), MAX_RECIPIENTS_PER_BROADCAST);
  // channel=email：只能從 list 拿 email
  if (channel === 'email') {
    if (!conds.savedListId) return { conditions: conds, rows: [] };
    const rs = await query(
      `SELECT u.id AS user_id, m.line_user_id, m.email, m.display_name
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> ''
         AND NOT EXISTS (SELECT 1 FROM admin_email_unsubscribes ue WHERE LOWER(ue.email) = LOWER(BTRIM(m.email)))
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, cappedLimit]
    );
    return { conditions: conds, rows: rs.rows };
  }
  if (!hasAnyCondition(conds)) return { conditions: conds, rows: [] };
  // 來源：已儲存名單
  if (conds.savedListId) {
    // LINE 通道：只送有 line_user_id 的成員、排除已封鎖（與預覽一致，避免灌水+漏發）
    const rs = await query(
      `SELECT u.id AS user_id, m.line_user_id
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
         AND (u.blocked_at IS NULL OR u.id IS NULL)
         AND (u.archived_at IS NULL OR u.id IS NULL)
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, cappedLimit]
    );
    return { conditions: conds, rows: rs.rows };
  }
  // 來源：條件篩選
  const { whereSql, params } = buildWhere(conds);
  params.push(cappedLimit);
  const sql = `
    SELECT u.id AS user_id, u.line_user_id
    FROM users u
    WHERE ${whereSql}
    ORDER BY u.id ASC
    LIMIT $${params.length}
  `;
  const rs = await query(sql, params);
  return { conditions: conds, rows: rs.rows };
}

module.exports = {
  MAX_RECIPIENTS_PER_BROADCAST,
  PREVIEW_SAMPLE_LIMIT,
  LIFECYCLE_STAGES,
  LIFECYCLE_NEW_DAYS,
  LIFECYCLE_ACTIVE_DAYS,
  LIFECYCLE_LOST_DAYS,
  LIFF_EVENTS_SOURCE,
  LIFF_EVENT_BOOKING_CLICK,
  BOOKING_SOURCE_VIEW,
  BOOKING_SOURCE_MAX_LEN,
  LAST_ACTIVITY_SQL,
  LIFECYCLE_STAGE_SQL,
  lifecycleWhereSql,
  normalizeConditions,
  hasAnyCondition,
  previewAudience,
  fetchAudienceRecipients
};
