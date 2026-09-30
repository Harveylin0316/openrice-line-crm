'use strict';
/**
 * 活動開啟成效漏斗：開啟 → 開始 → 完成 → 分享。
 *
 * 資料來源是 activity_user_events：
 *   enter    活動頁 /meta 完成 LINE token 驗證時寫入（每次載入／重查配額都會再寫一筆，
 *            所以「開啟次數」會膨脹，這裡一律以不重複用戶計算，不拿次數當 KPI）
 *   start    按下開始／發卡（play_key 去重，網路重送不算第二次）
 *   complete 伺服器回傳結果（同上）
 *   share    用戶在活動頁完成分享（Flex 卡片或文字連結）
 *
 * 只有通過 LINE 驗證的 sub 才會寫進來；安全預覽 preview=1 絕不寫入。
 */

const TREND_DAYS = 14;

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function rate(numerator, denominator) {
  const d = toInt(denominator);
  if (d <= 0) return null;
  return Math.round((toInt(numerator) / d) * 1000) / 10;
}

/**
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} query
 * @param {number} activityId
 */
function rangeCond(fromIdx, toIdx) {
  return `(($${fromIdx}::date IS NULL OR created_at >= ($${fromIdx}::date::timestamp AT TIME ZONE 'Asia/Taipei'))
       AND ($${toIdx}::date IS NULL OR created_at < (($${toIdx}::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei')))`;
}

/**
 * range（可選）：{ from, to } 台北曆日 YYYY-MM-DD，含起訖。
 * 沒給 range 時行為與原本一致（全部期間＋近 14 天趨勢）。
 */
async function loadActivityFunnel(query, activityId, range) {
  if (range && (range.from || range.to)) return loadActivityFunnelInRange(query, activityId, range);
  const id = Number(activityId);
  const { rows } = await query(
    `SELECT
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'enter')    AS openers,
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'start')    AS starters,
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'complete') AS completers,
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'share')    AS sharers,
       COUNT(*)                     FILTER (WHERE event_name = 'share')    AS shares,
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'enter'
                                              AND created_at >= NOW() - INTERVAL '24 hours') AS openers_24h,
       COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'enter'
                                              AND created_at >= NOW() - INTERVAL '7 days')   AS openers_7d,
       MIN(created_at) FILTER (WHERE event_name = 'enter') AS first_open_at,
       MAX(created_at) FILTER (WHERE event_name = 'enter') AS last_open_at
     FROM activity_user_events
     WHERE activity_id = $1`,
    [id]
  );
  const r = rows[0] || {};
  const { rows: trendRows } = await query(
    `SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date AS day,
            COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'enter')    AS openers,
            COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'complete') AS completers,
            COUNT(DISTINCT line_user_id) FILTER (WHERE event_name = 'share')    AS sharers
       FROM activity_user_events
      WHERE activity_id = $1
        AND created_at >= (((NOW() AT TIME ZONE 'Asia/Taipei')::date - ($2::int - 1))::timestamp AT TIME ZONE 'Asia/Taipei')
      GROUP BY 1
      ORDER BY 1 ASC`,
    [id, TREND_DAYS]
  );
  const openers = toInt(r.openers);
  const starters = toInt(r.starters);
  const completers = toInt(r.completers);
  const sharers = toInt(r.sharers);
  return {
    openers,
    starters,
    completers,
    sharers,
    shares: toInt(r.shares),
    openers_24h: toInt(r.openers_24h),
    openers_7d: toInt(r.openers_7d),
    first_open_at: r.first_open_at || null,
    last_open_at: r.last_open_at || null,
    start_rate: rate(starters, openers),
    complete_rate: rate(completers, openers),
    share_rate: rate(sharers, openers),
    trend: trendRows.map(t => ({
      day: t.day instanceof Date ? t.day.toISOString().slice(0, 10) : String(t.day).slice(0, 10),
      openers: toInt(t.openers),
      completers: toInt(t.completers),
      sharers: toInt(t.sharers)
    }))
  };
}

const MAX_RANGE_TREND_DAYS = 92;

async function loadActivityFunnelInRange(query, activityId, range) {
  const id = Number(activityId);
  const from = range.from || null;
  const to = range.to || null;
  const { rows } = await query(
    `WITH ranged_events AS (
       SELECT line_user_id, event_name, created_at
         FROM activity_user_events
        WHERE activity_id = $1 AND ${rangeCond(2, 3)}
     ),
     cohort AS (
       SELECT DISTINCT line_user_id
         FROM ranged_events
        WHERE event_name = 'enter' AND line_user_id IS NOT NULL
     )
     SELECT
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'enter')    AS openers,
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'start')    AS starters,
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'complete') AS completers,
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'share')    AS sharers,
       COUNT(*)                       FILTER (WHERE e.event_name = 'share')    AS shares,
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'enter'
                                                AND e.created_at >= NOW() - INTERVAL '24 hours') AS openers_24h,
       COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'enter'
                                                AND e.created_at >= NOW() - INTERVAL '7 days')   AS openers_7d,
       MIN(e.created_at) FILTER (WHERE e.event_name = 'enter') AS first_open_at,
       MAX(e.created_at) FILTER (WHERE e.event_name = 'enter') AS last_open_at
       FROM ranged_events e
       JOIN cohort c ON c.line_user_id = e.line_user_id`,
    [id, from, to]
  );
  const r = rows[0] || {};
  // 趨勢：範圍內每天；範圍太長只取最後 92 天，避免圖表擠爆
  const { rows: trendRows } = await query(
    `WITH ranged_events AS (
       SELECT line_user_id, event_name, created_at
         FROM activity_user_events
        WHERE activity_id = $1 AND ${rangeCond(2, 3)}
     ),
     cohort AS (
       SELECT DISTINCT line_user_id
         FROM ranged_events
        WHERE event_name = 'enter' AND line_user_id IS NOT NULL
     )
     SELECT (e.created_at AT TIME ZONE 'Asia/Taipei')::date AS day,
            COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'enter')    AS openers,
            COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'complete') AS completers,
            COUNT(DISTINCT e.line_user_id) FILTER (WHERE e.event_name = 'share')    AS sharers
       FROM ranged_events e
       JOIN cohort c ON c.line_user_id = e.line_user_id
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $4`,
    [id, from, to, MAX_RANGE_TREND_DAYS]
  );
  const openers = toInt(r.openers);
  const starters = toInt(r.starters);
  const completers = toInt(r.completers);
  const sharers = toInt(r.sharers);
  return {
    openers, starters, completers, sharers,
    shares: toInt(r.shares),
    openers_24h: toInt(r.openers_24h),
    openers_7d: toInt(r.openers_7d),
    first_open_at: r.first_open_at || null,
    last_open_at: r.last_open_at || null,
    start_rate: rate(starters, openers),
    complete_rate: rate(completers, openers),
    share_rate: rate(sharers, openers),
    ranged: true,
    trend: trendRows.slice().reverse().map(t => ({
      day: t.day instanceof Date ? t.day.toISOString().slice(0, 10) : String(t.day).slice(0, 10),
      openers: toInt(t.openers),
      completers: toInt(t.completers),
      sharers: toInt(t.sharers)
    }))
  };
}

module.exports = { loadActivityFunnel, TREND_DAYS, MAX_RANGE_TREND_DAYS };
