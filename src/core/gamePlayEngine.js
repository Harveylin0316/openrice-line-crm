/**
 * 通用遊戲抽選引擎 — 給所有 game types 共用（wheel / fortune / scratch / slot）
 *
 * 提供：
 *   selectPrizeAndRecord({pool, query, activity, lineUserId, lineDisplayName, gameType, properties, req})
 *     交易內：驗活動 active + 期間 / quota / 抽選獎品 / 扣庫存 / 寫 plays
 *
 *   computeUserQuota(query, activity, lineUserId)
 *     計算用戶的 quota 狀態（base + referral bonus）
 *
 * 共用邏輯確保所有遊戲類型「中獎邏輯一致」「資料一致」「未來可重用 helper」
 */
const { verifyOaFollower } = require('./oaFollower');

/** 從已存的遊玩紀錄還原回應——同一個 play_key 重送時回同一個結果，不重複扣次數 */
function replayFromRow(row) {
  const snap = row.prize_snapshot || {};
  return {
    ok: true,
    replayed: true,
    play_id: row.id,
    coupon_code: row.coupon_code || null,
    coupon_out_of_stock: false,
    prize: {
      id: row.prize_id,
      name: snap.name, description: snap.description,
      image_url: snap.image_url || null, position: snap.position || 0,
      is_grand_prize: !!snap.is_grand_prize,
      prize_type: snap.prize_type, prize_value: snap.prize_value || {},
      coupon_code: row.coupon_code || null
    }
  };
}

async function selectPrizeAndRecord(opts) {
  const { pool, activitySlug, gameType, lineUserId, lineDisplayName, req, playKey } = opts;
  if (!lineUserId) return { error: { status: 400, code: 'missing_line_user_id' } };
  // 註：require_follow_oa 的好友驗證已移到 /play 路由，與 token 驗證「並行」執行（加速「準備中」）。

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 取活動 + 驗
    const { rows: actRows } = await client.query(
      `SELECT id, status, start_at, end_at,
              daily_plays_per_user, base_plays_per_user,
              referral_bonus_per, referral_bonus_max, referral_invites_per_bonus
       FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
      [activitySlug, gameType]
    );
    if (actRows.length === 0) {
      await client.query('ROLLBACK');
      return { error: { status: 404, code: 'activity_not_found' } };
    }
    const a = actRows[0];
    // 防重複扣次數：收訊差的用戶按了但回應沒送達，再按一次會帶同一把鑰匙——
    // 查到同鑰匙的紀錄就回原本的結果，次數只扣一次。必須在扣次數檢查之前查，
    // 否則重送的那次會因為「次數已用完」被擋，用戶永遠拿不到他抽到的結果。
    if (playKey) {
      const { rows: dup } = await client.query(
        `SELECT id, prize_id, prize_snapshot, coupon_code FROM activity_plays
          WHERE activity_id = $1 AND line_user_id = $2 AND properties->>'play_key' = $3 LIMIT 1`,
        [a.id, lineUserId, playKey]);
      if (dup.length) {
        await client.query('ROLLBACK');
        return replayFromRow(dup[0]);
      }
    }
    if (a.status !== 'active') {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_not_active', detail: '活動目前不可玩' } };
    }
    const now = new Date();
    if (a.start_at && now < new Date(a.start_at)) {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_not_started', detail: '活動尚未開始' } };
    }
    if (a.end_at && now > new Date(a.end_at)) {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_ended', detail: '活動已結束' } };
    }

    // 2) Quota 檢查（含 per-user override + base + referral bonus）
    // 次數一律走 computeUserQuota——**唯一一份公式**。
    // 這裡以前自己另寫了一套，三個地方跟顯示用的不一致：
    //   既有好友照樣加次數（防洗根本沒生效）、忽略「每幾位換一次」、不算人工補發的次數。
    // 用同一個 client 執行，才會在同一個交易與鎖裡面。
    const txQuery = (sql, params) => client.query(sql, params);
    const quota = await computeUserQuota(txQuery, a, lineUserId);
    const totalQuota = quota.total;
    const played = quota.played;
    if (played >= totalQuota) {
      await client.query('ROLLBACK');
      const canEarnMore = !quota.override && quota.referral_bonus_per > 0 &&
        quota.referral_bonus < quota.referral_bonus_max;
      return {
        error: {
          status: 429,
          code: 'quota_exhausted',
          detail: canEarnMore
            ? '次數已用完！邀請還沒加入官方帳號的朋友來玩可以再加 ' + quota.referral_bonus_per + ' 次。'
            : (quota.override ? '此用戶配額已用完（後台設定上限 ' + totalQuota + ' 次）。' : '次數已用完。'),
          quota: quota
        }
      };
    }

    // 3) Daily limit 額外檢查
    if (a.daily_plays_per_user != null) {
      const { rows: dCount } = await client.query(
        `SELECT COUNT(*) AS c FROM activity_plays
         WHERE activity_id = $1 AND line_user_id = $2
           AND played_at >= date_trunc('day', NOW())
           AND COALESCE(prize_snapshot->>'kind', '') <> 'draw_win'`,
        [a.id, lineUserId]
      );
      if (Number(dCount[0].c) >= a.daily_plays_per_user) {
        await client.query('ROLLBACK');
        return {
          error: {
            status: 429,
            code: 'daily_limit_reached',
            detail: '今天已達可玩次數上限（' + a.daily_plays_per_user + ' 次），明天再來。'
          }
        };
      }
    }

    // 4) 取獎品池（鎖列）
    const { rows: prizes } = await client.query(
      `SELECT id, name, description, probability_weight, stock_total, stock_remaining,
              prize_type, prize_value, image_url, is_grand_prize, position
       FROM activity_prizes
       WHERE activity_id = $1
         AND (stock_total IS NULL OR stock_remaining > 0)
       ORDER BY position ASC, id ASC
       FOR UPDATE`,
      [a.id]
    );
    if (prizes.length === 0) {
      await client.query('ROLLBACK');
      return { error: { status: 503, code: 'no_prize_available', detail: '所有獎品都已抽完。' } };
    }

    // 併發防護：取得獎品列鎖（FOR UPDATE）後複查遊玩數，避免併發 /play 超領
    // （所有 play 都鎖同一批 activity_prizes 列 → 同活動同用戶會被序列化）
    const { rows: reCount } = await client.query(
      `SELECT COUNT(*) AS c FROM activity_plays
        WHERE activity_id = $1 AND line_user_id = $2
          AND COALESCE(prize_snapshot->>'kind', '') <> 'draw_win'`,
      [a.id, lineUserId]
    );
    if (Number(reCount[0].c) >= totalQuota) {
      await client.query('ROLLBACK');
      return { error: { status: 429, code: 'quota_exhausted', detail: '次數已用完。' } };
    }

    // 5) 加權隨機
    const totalWeight = prizes.reduce((s, p) => s + Number(p.probability_weight || 0), 0);
    if (totalWeight <= 0) {
      await client.query('ROLLBACK');
      return { error: { status: 500, code: 'no_valid_weight', detail: '所有獎品權重為 0。' } };
    }
    let pick = null;
    const r = Math.random() * totalWeight;
    let acc = 0;
    for (const p of prizes) {
      acc += Number(p.probability_weight || 0);
      if (r < acc) { pick = p; break; }
    }
    if (!pick) pick = prizes[prizes.length - 1];

    // 6) 扣庫存
    if (pick.stock_total != null) {
      await client.query(
        'UPDATE activity_prizes SET stock_remaining = stock_remaining - 1 WHERE id = $1',
        [pick.id]
      );
    }

    // 7) 寫 play 紀錄
    const prizeSnapshot = {
      name: pick.name,
      description: pick.description,
      position: pick.position,
      prize_type: pick.prize_type,
      prize_value: pick.prize_value || {},
      image_url: pick.image_url || null,
      is_grand_prize: pick.is_grand_prize
    };
    const { rows: playRow } = await client.query(
      `INSERT INTO activity_plays
         (activity_id, line_user_id, line_display_name, prize_id, prize_snapshot, properties, played_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
       RETURNING id, played_at`,
      [
        a.id, lineUserId, lineDisplayName || null, pick.id,
        JSON.stringify(prizeSnapshot),
        JSON.stringify({
          game_type: gameType,
          play_key: playKey || undefined,
          ua: req && req.headers && req.headers['user-agent'] || null,
          ip: req && ((req.headers && req.headers['x-forwarded-for']) || req.ip || '')
            ? (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null
            : null
        })
      ]
    );

    const playId = playRow[0].id;

    // 8) 優惠券碼領取（僅 prize_type='coupon_code'）
    //    在同一交易內、INSERT play 拿到 play_id 之後、COMMIT 之前，
    //    從該 (activity_id, prize_id) 的碼池原子領一張 available 碼。
    //    領不到（碼用完）→ coupon_code 留 NULL、play 照常 COMMIT，
    //    絕不可因缺碼 rollback 或讓整個 /play 失敗。
    let couponCode = null;
    let couponOutOfStock = false;
    if (pick.prize_type === 'coupon_code') {
      const { rows: codeRows } = await client.query(
        `UPDATE coupon_codes
            SET status='claimed', claimed_play_id=$1, claimed_line_user_id=$2, claimed_at=now()
          WHERE id = (
            SELECT id FROM coupon_codes
             WHERE activity_id=$3 AND prize_id=$4 AND status='available'
             ORDER BY id LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING code`,
        [playId, lineUserId, a.id, pick.id]
      );
      if (codeRows.length > 0) {
        couponCode = codeRows[0].code;
        await client.query(
          'UPDATE activity_plays SET coupon_code = $1 WHERE id = $2',
          [couponCode, playId]
        );
      } else {
        couponOutOfStock = true;
      }
    }

    await client.query('COMMIT');

    return {
      ok: true,
      play_id: playId,
      coupon_code: couponCode,
      coupon_out_of_stock: couponOutOfStock,
      prize: {
        id: pick.id,
        name: pick.name,
        description: pick.description,
        image_url: pick.image_url,
        position: pick.position,
        is_grand_prize: pick.is_grand_prize,
        prize_type: pick.prize_type,
        prize_value: pick.prize_value || {},
        coupon_code: couponCode
      }
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) {}
    if (playKey && String(err && err.message || '').includes('uq_plays_play_key')) {
      // 同鑰匙的另一個請求剛好先寫進去了——把那筆撈出來照樣回給用戶
      try {
        const { rows: dup } = await pool.query(
          `SELECT p.id, p.prize_id, p.prize_snapshot, p.coupon_code FROM activity_plays p
            JOIN activities a2 ON a2.id = p.activity_id
           WHERE a2.slug = $1 AND p.line_user_id = $2 AND p.properties->>'play_key' = $3 LIMIT 1`,
          [activitySlug, lineUserId, playKey]);
        if (dup.length) return replayFromRow(dup[0]);
      } catch (_e2) { /* 撈不到就走一般錯誤 */ }
    }
    console.error('selectPrizeAndRecord error:', err && err.message);
    return { error: { status: 500, code: 'play_failed', detail: String(err.message || '').slice(0, 300) } };
  } finally {
    client.release();
  }
}

/**
 * 次數算式的**唯一一份**。要顯示或判定次數一律呼叫這裡，不要自己算。
 * 之前「玩的關卡」與「畫面顯示」各寫一份，導致防洗失效、忽略「每幾位換一次」、
 * 人工補發沒算到——修過一次就是為了這個，不要再複製一份出去。
 */
function computeQuotaNumbers(cfg) {
  const basePlays = Number(cfg.basePlays || 0);
  const refPer = Number(cfg.refPer || 0);
  const refMax = Number(cfg.refMax || 0);
  const invitesPer = Math.max(1, Number(cfg.invitesPer || 1));
  const newFriends = Number(cfg.newFriends || 0);
  const manualBonus = Number(cfg.manualBonus || 0);
  const played = Number(cfg.played || 0);
  const override = (cfg.override === null || cfg.override === undefined) ? null : Number(cfg.override);
  const referralBonus = Math.min(refMax, Math.floor(newFriends / invitesPer) * refPer);
  const nextBonusIn = (referralBonus >= refMax || refPer <= 0)
    ? 0 : invitesPer - (newFriends % invitesPer);
  const total = (override === null ? basePlays + referralBonus : override) + manualBonus;
  return { total, played, remaining: Math.max(0, total - played),
    referral_bonus: referralBonus, next_bonus_in: nextBonusIn };
}

async function computeUserQuota(query, activity, lineUserId) {
  const basePlays = Number(activity.base_plays_per_user || 1);
  const refPer = Number(activity.referral_bonus_per || 0);
  const refMax = Number(activity.referral_bonus_max || 0);
  // 每邀幾位朋友換一份加碼（預設 1 = 每邀 1 人 +refPer 次；九月活動設 2 = 邀 2 人 +1 次）
  const invitesPer = Math.max(1, Number(activity.referral_invites_per_bonus || 1));
  // 1) 個別用戶配額 override（admin 後台設的）
  const { rows: overrideRows } = await query(
    `SELECT max_plays_override, note FROM activity_user_quotas
     WHERE activity_id = $1 AND line_user_id = $2 LIMIT 1`,
    [activity.id, lineUserId]
  );
  const override = overrideRows[0] || null;
  // 2) 已玩次數
  const { rows: playedRows } = await query(
    `SELECT COUNT(*) AS c FROM activity_plays
      WHERE activity_id = $1 AND line_user_id = $2
        AND COALESCE(prize_snapshot->>'kind', '') <> 'draw_win'`,
    [activity.id, lineUserId]
  );
  const played = Number(playedRows[0].c);
  // 3) 邀請成功數 —— 只算「本來不是官方帳號好友」的人。
  //    既有好友互點連結不加次數：否則幾百位老友互洗就能刷出無限次遊戲。
  const { rows: refRows } = await query(
    `SELECT COUNT(*) FILTER (WHERE invitee_was_existing IS FALSE) AS c,
            COUNT(*) FILTER (WHERE invitee_was_existing IS NOT FALSE) AS existing
       FROM activity_referrals
      WHERE activity_id = $1 AND inviter_line_user_id = $2`,
    [activity.id, lineUserId]
  );
  const referrals = Number(refRows[0].c);
  const referralsExisting = Number(refRows[0].existing);
  // 4) 加碼次數（揪友賺哩等活動發的，冪等發放，與邀請加成分開計）
  const { rows: bonusRows } = await query(
    `SELECT COALESCE(SUM(plays), 0)::int AS b FROM activity_bonus_plays
      WHERE activity_id = $1 AND line_user_id = $2`,
    [activity.id, lineUserId]
  );
  const bonusPlays = Number(bonusRows[0].b || 0);
  const nums = computeQuotaNumbers({
    basePlays, refPer, refMax, invitesPer,
    newFriends: referrals, manualBonus: bonusPlays, played,
    override: override ? Number(override.max_plays_override) : null
  });
  const total = nums.total;
  const referralBonus = nums.referral_bonus;
  const nextBonusIn = nums.next_bonus_in;
  return {
    total,
    played,
    remaining: Math.max(0, total - played),
    referrals,
    referrals_existing: referralsExisting,
    base: basePlays,
    referral_bonus: referralBonus,
    referral_bonus_max: refMax,
    referral_bonus_per: refPer,
    referral_invites_per_bonus: invitesPer,
    next_bonus_in: nextBonusIn,
    bonus_plays: bonusPlays,
    override: override ? {
      max_plays: Number(override.max_plays_override),
      note: override.note || null
    } : null
  };
}

// ---- 邀請成功即時通知（fire-and-forget）----
// 防騷擾：同一活動同一邀請人 60 秒內只通知一次（in-memory Map）。
// 注意：serverless（Netlify Functions）下每個 instance 各自一份 Map，跨 instance 不去重，
// 屬「盡力而為」；搭配 LINE X-Line-Retry-Key（同一筆 referral 冪等）已足夠避免重複轟炸。
const REFERRAL_NOTIFY_COOLDOWN_MS = 60 * 1000;
const referralNotifyLastAt = new Map();

function shouldSkipReferralNotify(key) {
  const now = Date.now();
  const last = referralNotifyLastAt.get(key);
  if (last && now - last < REFERRAL_NOTIFY_COOLDOWN_MS) return true;
  // 順手清掉過期項目，避免 Map 無限成長
  if (referralNotifyLastAt.size > 500) {
    for (const [k, t] of referralNotifyLastAt) {
      if (now - t >= REFERRAL_NOTIFY_COOLDOWN_MS) referralNotifyLastAt.delete(k);
    }
  }
  referralNotifyLastAt.set(key, now);
  return false;
}

// 盡力取得被邀請人的 LINE 顯示名稱（registerReferral 前已驗過是 OA 好友，profile 端點通常可取）
async function fetchLineDisplayName(lineUserId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token || !lineUserId) return null;
  try {
    const resp = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(lineUserId), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const name = data && typeof data.displayName === 'string' ? data.displayName.trim() : '';
    return name || null;
  } catch (_e) {
    return null;
  }
}

async function notifyInviterOfReferral({ query, activity, activitySlug, gameType, inviterId, inviteeId, inviteeWasExisting }) {
  if (shouldSkipReferralNotify(activity.id + ':' + inviterId)) return;
  const refPer = Number(activity.referral_bonus_per || 0);
  const refMax = Number(activity.referral_bonus_max || 0);
  const invitesPer = Math.max(1, Number(activity.referral_invites_per_bonus || 1));
  // 只算「本來不是好友」的——要跟 computeUserQuota 同一套算法。
  // 這裡以前算的是所有點過連結的人，於是推播說「+1 次」但實際沒加，兩邊對不上。
  const { rows: refRows } = await query(
    `SELECT COUNT(*) AS c FROM activity_referrals
     WHERE activity_id = $1 AND inviter_line_user_id = $2
       AND invitee_was_existing IS FALSE`,
    [activity.id, inviterId]
  );
  const count = Number(refRows[0].c);
  // 本次實際入帳的加碼（與 computeUserQuota 同一套公式：每 invitesPer 人換 refPer 次、上限 refMax）
  const bonusAt = (c) => Math.min(refMax, Math.floor(c / invitesPer) * refPer);
  const gained = bonusAt(count) - bonusAt(count - 1);
  const who = (await fetchLineDisplayName(inviteeId)) || '1 位好友';
  // 遊戲連結組法與 games 路由 / 各 game view 一致：https://liff.line.me/{liffId}/{gameType}/{slug}
  const liffId = (activity.liff_id_override && String(activity.liff_id_override).trim()) ||
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';
  const gameUrl = liffId
    ? 'https://liff.line.me/' + liffId + '/' + gameType + '/' + encodeURIComponent(activitySlug)
    : '';
  let text;
  const capped = bonusAt(count) >= refMax;
  const toNext = invitesPer - (count % invitesPer);
  if (inviteeWasExisting === true) {
    // 對方本來就是官方帳號好友：不加次數。要照實說，否則邀請人會等一個永遠不會來的次數。
    text = who + ' 打開了你的連結，不過他本來就是官方帳號好友，這次不會多一次機會。' +
      '找還沒加入官方帳號的朋友才會加。';
    if (gameUrl) text += '你的遊戲在這：' + gameUrl;
  } else if (gained > 0) {
    text = '邀請成功！' + who + ' 已透過你的連結加入。你獲得 +' + gained +
      ' 次遊戲機會（已邀 ' + count + ' 位，上限 +' + refMax + ' 次）。';
    if (gameUrl) text += '打開遊戲馬上用：' + gameUrl;
  } else if (refMax > 0 && !capped && invitesPer > 1) {
    // 邀 2 換 1 的中間態：湊滿才入帳，要講進度，不然邀請人以為系統沒記到
    text = '邀請成功！' + who + ' 已透過你的連結加入。已邀 ' + count +
      ' 位，再邀 ' + (toNext === invitesPer ? invitesPer : toNext) + ' 位就多 1 次遊戲機會。';
  } else if (refMax > 0) {
    text = '邀請成功！' + who + ' 已加入。你的邀請加碼已達上限（+' + refMax + ' 次全數入帳），仍感謝你的分享！';
  } else {
    // referral_bonus_max <= 0 的設定邊界：避免「+0 次全數入帳」這種怪文案
    text = '邀請成功！' + who + ' 已透過你的連結加入，感謝你的分享！';
  }
  const { createLinePushService } = require('./linePush');
  const linePush = createLinePushService({
    query,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
  });
  await linePush.pushLineMessages(inviterId, [text], {
    pushType: 'referral_inviter_notify',
    retryKey: 'referral-notify:' + activity.id + ':' + inviterId + ':' + inviteeId
  });
}

async function registerReferral({ query, activitySlug, gameType, inviterId, inviteeId }) {
  if (!inviteeId || !inviterId) {
    return { error: { status: 400, code: 'missing_ids' } };
  }
  if (inviteeId === inviterId) {
    return { error: { status: 400, code: 'self_referral', detail: '不能邀請自己' } };
  }
  // inviter 來自網址的 ?ref=，前端可任意竄改 → 至少要求格式正確且真的是本 OA 的會員，
  // 否則任何人都能把別人（或亂打的 id）灌成邀請人。
  if (!/^U[0-9a-f]{32}$/i.test(String(inviterId))) {
    return { error: { status: 400, code: 'bad_inviter', detail: '邀請連結無效' } };
  }
  const { rows: act } = await query(
    `SELECT id, status, start_at, end_at, referral_bonus_per, referral_bonus_max, referral_invites_per_bonus, liff_id_override
     FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
    [activitySlug, gameType]
  );
  if (act.length === 0) return { error: { status: 404, code: 'activity_not_found' } };
  const a = act[0];
  if (!a.referral_bonus_per || a.referral_bonus_per <= 0) {
    return { error: { status: 400, code: 'mgm_disabled', detail: '此活動未啟用邀請機制' } };
  }
  // 活動期間外不該累積邀請數：原本完全沒檢查，草稿階段與活動結束後都還能灌，
  // 導致活動一開跑就有人已經滿配額。
  const nowMs = Date.now();
  if (a.status !== 'active') {
    return { error: { status: 400, code: 'activity_not_active', detail: '活動尚未開始或已結束' } };
  }
  if (a.start_at && nowMs < new Date(a.start_at).getTime()) {
    return { error: { status: 400, code: 'activity_not_started', detail: '活動尚未開始' } };
  }
  if (a.end_at && nowMs > new Date(a.end_at).getTime()) {
    return { error: { status: 400, code: 'activity_ended', detail: '活動已結束' } };
  }
  // 邀請人必須是本 OA 的現行會員（archived = 舊 OA 的歷史會員，其 id 對現行 OA 無效）
  const { rows: inv } = await query(
    `SELECT 1 FROM users WHERE line_user_id = $1 AND archived_at IS NULL LIMIT 1`,
    [inviterId]
  );
  if (inv.length === 0) {
    return { error: { status: 400, code: 'inviter_not_member', detail: '邀請連結無效' } };
  }
  // 只認「真實加 OA 好友的被邀者」：擋偽造假 id 灌配額、確保邀請真的長 OA、獎勵對應真實獲客
  // fail-closed：null（LINE API 429/5xx/沒 token）也不寫。玩一次的成本可以吸收，
  // 但 activity_referrals 有 UNIQUE，寫錯一列永久回不來，也分不出當時到底加了沒。
  // 前端拿到 follow_check_unavailable 會留著邀請、稍後自動重送。
  const invFollows = await verifyOaFollower(inviteeId);
  if (invFollows !== true) {
    return invFollows === false
      ? { error: { status: 400, code: 'invitee_not_follower', detail: '被邀請的人要先加官方帳號好友，邀請才算成功。' } }
      : { error: { status: 400, code: 'follow_check_unavailable', detail: '好友狀態暫時查不到，等一下會自動再試。' } };
  }
  // 被邀請人「在這次邀請之前」是不是已經是會員？照樣算邀請成功（剛好已追蹤就判無效，
  // 客訴大於效益），但記下來，報表才分得出「真的拉到新客」與「邀既有好友」。
  let inviteeWasExisting = null;
  try {
    const { rows: ex } = await query(
      `SELECT 1 FROM users WHERE line_user_id = $1 AND archived_at IS NULL LIMIT 1`,
      [inviteeId]
    );
    inviteeWasExisting = ex.length > 0;
  } catch (e) { /* 判斷失敗就記 NULL，不影響邀請本身 */ }

  const ins = await query(
    `INSERT INTO activity_referrals (activity_id, inviter_line_user_id, invitee_line_user_id, invitee_was_existing)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (activity_id, invitee_line_user_id) DO NOTHING
     RETURNING id`,
    [a.id, inviterId, inviteeId, inviteeWasExisting]
  );
  const counted = ins.rows.length > 0;
  let sameInviter = null;
  if (!counted) {
    try {
      const { rows: ex } = await query(
        `SELECT inviter_line_user_id FROM activity_referrals
          WHERE activity_id = $1 AND invitee_line_user_id = $2 LIMIT 1`,
        [a.id, inviteeId]
      );
      sameInviter = !!(ex[0] && ex[0].inviter_line_user_id === inviterId);
    } catch (e) { /* 查不到就回 null，前端當作靜默處理 */ }
  }
  if (counted && gameType !== 'mgm') {
    // 邀請成功 → 即時通知邀請人。fire-and-forget：通知失敗絕不影響 API 回應。
    // MGM（揪友賺哩）有自己的里程碑卡片，不走這個遊戲式通知
    notifyInviterOfReferral({ query, activity: a, activitySlug, gameType, inviterId, inviteeId, inviteeWasExisting })
      .catch(err => console.error('referral inviter notify failed:', err && err.message));
  }
  return { ok: true, counted, same_inviter: sameInviter, invitee_was_existing: inviteeWasExisting };
}

module.exports = { selectPrizeAndRecord, computeUserQuota, computeQuotaNumbers, registerReferral, notifyInviterOfReferral };
