'use strict';
/**
 * 領取優惠券（game_type = claim）轉換漏斗：同一批人、固定觀察期、不重複人數。
 *
 * 同一批人（cohort）：「第一次開啟領券頁」落在所選期間（台北曆日，含起訖）的不重複 LINE 用戶。
 *   沒選期間 = 所有開啟過的人。以第一次開啟為準，之後再回來看不會重新算一次。
 * 固定觀察期：每個人從「自己第一次開啟」起算 N 天內完成的步驟才算（預設 7 天），
 *   不同時間進來的人用同一把尺，今天剛進來的人不會因為還沒過 N 天而被拿去跟舊人比（見 matured）。
 * 四個步驟（每一步都是不重複人數）：
 *   1 開啟畫面   activity_user_events.event_name = 'enter'（LINE 身分驗證成功、頁面載入）
 *   2 顯示序號   activity_plays 有 coupon_code（按領取後拿到並顯示序號）；
 *                按了領取但序號已發完 → 另計「序號發完」，不算顯示序號
 *   3 複製序號   activity_user_events.event_name = 'copy_code'（按「複製序號」）
 *   4 前往兌換   activity_plays.properties.redeem_clicked_at 或 event 'redeem_click'（按「前往兌換」）
 * 好友分群：以會員加入日期（users.created_at，台北曆日，同名單庫「加入日期」）對照分界日（預設 2026-09-01）：
 *   既有好友 = 分界日前加入；新好友 = 分界日當天或之後加入；未知 = 會員表查不到。
 */

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_CUTOFF = '2026-09-01';
const WINDOW_CHOICES = [1, 3, 7, 14, 30];

function clampWindow(v) {
  const n = Math.floor(Number(v));
  return WINDOW_CHOICES.includes(n) ? n : DEFAULT_WINDOW_DAYS;
}

function pct(n, d) {
  const nn = Number(n) || 0;
  const dd = Number(d) || 0;
  return dd > 0 ? Math.round((nn / dd) * 1000) / 10 : null;
}

function stepsWithRates(r) {
  const cohortTotal = Number(r.cohort_total || 0);
  const opened = Number(r.opened || 0);
  const shown = Number(r.shown || 0);
  const copied = Number(r.copied || 0);
  const redeemed = Number(r.redeemed || 0);
  return {
    cohort_total: cohortTotal,
    opened,
    shown,
    out_of_stock: Number(r.out_of_stock || 0),
    copied,
    redeemed,
    matured: Number(r.matured || 0),
    inferred_open: Number(r.inferred_open || 0),
    // 對開啟（整體轉換）與對上一步（步驟轉換）
    shown_rate: pct(shown, opened),
    copied_rate: pct(copied, opened),
    redeemed_rate: pct(redeemed, opened),
    copied_step_rate: pct(copied, shown),
    redeemed_step_rate: pct(redeemed, shown)
  };
}

/**
 * @param {Function} query
 * @param {number} activityId
 * @param {{from?:string|null,to?:string|null,windowDays?:number,cutoff?:string}} opts
 */
async function loadClaimFunnel(query, activityId, opts = {}) {
  const from = opts.from || null;
  const to = opts.to || null;
  const windowDays = clampWindow(opts.windowDays);
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.cutoff || '')) ? String(opts.cutoff) : DEFAULT_CUTOFF;
  const { rows } = await query(
    `WITH first_open AS (
       -- 開啟畫面：有 enter 紀錄就用；「開啟紀錄」是 9/17 才開始記的，之前的人沒有 enter，
       -- 但有領取（activity_plays）就一定開過畫面 → 以第一次領取時間當作開啟時間（has_enter=false，畫面上會註明）
       SELECT line_user_id, MIN(at) AS opened_at, BOOL_OR(is_enter) AS has_enter
         FROM (
           SELECT line_user_id, created_at AS at, true AS is_enter
             FROM activity_user_events
            WHERE activity_id = $1 AND event_name = 'enter' AND line_user_id IS NOT NULL
           UNION ALL
           SELECT line_user_id, played_at AS at, false AS is_enter
             FROM activity_plays
            WHERE activity_id = $1 AND line_user_id IS NOT NULL
              AND COALESCE(prize_snapshot->>'kind', '') <> 'draw_win'
         ) x
        GROUP BY line_user_id
     ),
     cohort AS (
       SELECT fo.line_user_id, fo.opened_at, fo.has_enter,
              fo.opened_at + ($4::int * INTERVAL '1 day') AS window_end
         FROM first_open fo
        WHERE ($2::date IS NULL OR fo.opened_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Taipei'))
          AND ($3::date IS NULL OR fo.opened_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei'))
     ),
     tagged AS (
       SELECT c.*,
              CASE
                WHEN u.created_at IS NULL THEN 'unknown'
                WHEN (u.created_at AT TIME ZONE 'Asia/Taipei')::date < $5::date THEN 'existing'
                ELSE 'new'
              END AS seg,
              EXISTS (SELECT 1 FROM activity_plays p
                       WHERE p.activity_id = $1 AND p.line_user_id = c.line_user_id
                         AND p.coupon_code IS NOT NULL
                         AND p.played_at >= c.opened_at AND p.played_at < c.window_end) AS shown,
              EXISTS (SELECT 1 FROM activity_plays p
                       WHERE p.activity_id = $1 AND p.line_user_id = c.line_user_id
                         AND p.coupon_code IS NULL
                         AND COALESCE(p.prize_snapshot->>'kind','') <> 'draw_win'
                         AND p.played_at >= c.opened_at AND p.played_at < c.window_end) AS tried,
              EXISTS (SELECT 1 FROM activity_user_events e
                       WHERE e.activity_id = $1 AND e.line_user_id = c.line_user_id
                         AND e.event_name = 'copy_code'
                         AND e.created_at >= c.opened_at AND e.created_at < c.window_end) AS copied,
              (EXISTS (SELECT 1 FROM activity_plays p
                        WHERE p.activity_id = $1 AND p.line_user_id = c.line_user_id
                          AND (p.properties->>'redeem_clicked_at') IS NOT NULL
                          AND (p.properties->>'redeem_clicked_at')::timestamptz >= c.opened_at
                          AND (p.properties->>'redeem_clicked_at')::timestamptz < c.window_end)
               OR EXISTS (SELECT 1 FROM activity_user_events e
                        WHERE e.activity_id = $1 AND e.line_user_id = c.line_user_id
                          AND e.event_name = 'redeem_click'
                          AND e.created_at >= c.opened_at AND e.created_at < c.window_end)) AS redeemed,
              (c.window_end <= NOW()) AS matured
         FROM cohort c
         LEFT JOIN LATERAL (
           SELECT created_at FROM users
            WHERE line_user_id = c.line_user_id
            ORDER BY created_at ASC LIMIT 1
         ) u ON TRUE
     )
     SELECT seg,
            COUNT(*)::int AS cohort_total,
            COUNT(*) FILTER (WHERE matured)::int AS opened,
            COUNT(*) FILTER (WHERE matured AND shown)::int AS shown,
            COUNT(*) FILTER (WHERE matured AND tried AND NOT shown)::int AS out_of_stock,
            COUNT(*) FILTER (WHERE matured AND shown AND copied)::int AS copied,
            COUNT(*) FILTER (WHERE matured AND shown AND redeemed)::int AS redeemed,
            COUNT(*) FILTER (WHERE matured)::int AS matured,
            COUNT(*) FILTER (WHERE matured AND NOT has_enter)::int AS inferred_open
       FROM tagged
      GROUP BY seg`,
    [Number(activityId), from, to, windowDays, cutoff]
  );
  const zero = { cohort_total: 0, opened: 0, shown: 0, out_of_stock: 0, copied: 0, redeemed: 0, matured: 0, inferred_open: 0 };
  // 各步驟從哪一天開始有紀錄（全系統第一筆）：選的期間在這之前，該步驟顯示「未記錄」而不是 0
  let tracking = null;
  try {
    const t = (await query(
      `SELECT
         (SELECT to_char(MIN(created_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') FROM activity_user_events WHERE event_name = 'enter') AS enter_since,
         (SELECT to_char(MIN(created_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') FROM activity_user_events WHERE event_name = 'copy_code') AS copy_since,
         (SELECT to_char(MIN(created_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') FROM activity_user_events WHERE event_name = 'redeem_click') AS redeem_event_since,
         (SELECT to_char(MIN((properties->>'redeem_clicked_at')::timestamptz) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')
            FROM activity_plays WHERE properties ? 'redeem_clicked_at') AS redeem_prop_since`
    )).rows[0] || {};
    const minDate = (a, b) => (!a ? (b || null) : !b ? a : (a < b ? a : b));
    tracking = { enter_since: t.enter_since || null, copy_since: t.copy_since || null,
      redeem_since: minDate(t.redeem_event_since, t.redeem_prop_since) };
  } catch (e) { /* 查不到就不標示 */ }
  const by = { existing: { ...zero }, new: { ...zero }, unknown: { ...zero } };
  rows.forEach(r => { if (by[r.seg]) by[r.seg] = r; });
  const all = Object.keys(zero).reduce((acc, k) => {
    acc[k] = Number(by.existing[k] || 0) + Number(by.new[k] || 0) + Number(by.unknown[k] || 0);
    return acc;
  }, {});
  return {
    range: { from, to },
    window_days: windowDays,
    window_choices: WINDOW_CHOICES,
    cutoff,
    tracking,
    all: stepsWithRates(all),
    existing: stepsWithRates(by.existing),
    new: stepsWithRates(by.new),
    unknown: stepsWithRates(by.unknown)
  };
}

module.exports = { loadClaimFunnel, DEFAULT_WINDOW_DAYS, DEFAULT_CUTOFF, WINDOW_CHOICES };
