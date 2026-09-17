'use strict';

const MAX_CONDITIONS = 30;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDefinition(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const operator = String(input.operator || 'and').toLowerCase() === 'or' ? 'or' : 'and';
  const source = Array.isArray(input.conditions) ? input.conditions.slice(0, MAX_CONDITIONS) : [];
  const conditions = source.map(cleanCondition).filter(Boolean);
  if (!conditions.length) throw new Error('至少要設定一個受眾條件');
  return { version: 1, operator, conditions };
}

function cleanCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  const mode = String(raw.mode || 'include').toLowerCase() === 'exclude' ? 'exclude' : 'include';
  const value = raw.value;
  if (!CONDITION_TYPES.has(type)) throw new Error('不支援的受眾條件：' + type);
  if (['joined_after', 'joined_before'].includes(type) && !ISO_DATE.test(String(value || ''))) {
    throw new Error('加入日期格式錯誤');
  }
  if (['tag', 'rich_menu', 'activity', 'activity_enter', 'activity_start', 'activity_complete', 'activity_share', 'successful_invite', 'broadcast_sent', 'broadcast_delivered', 'broadcast_opened', 'broadcast_clicked', 'broadcast_tested', 'broadcast_converted'].includes(type)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error('條件缺少有效編號：' + type);
    return { type, mode, value: n };
  }
  if (type === 'liff_event') {
    const text = String(value || '').trim().slice(0, 80);
    if (!text) throw new Error('LIFF 行為不可空白');
    return { type, mode, value: text };
  }
  if (type === 'rich_menu_button') {
    const text = String(value || '').trim();
    if (!/^\d+:\d+:\d+$/.test(text)) throw new Error('圖文選單按鈕格式應為：選單編號:分頁:格子');
    return { type, mode, value: text };
  }
  if (type === 'invite_count') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('成功邀請次數需為 1–10000');
    return { type, mode, value: n };
  }
  if (type === 'reward_status') {
    const v = String(value || 'obtained');
    if (!['obtained', 'unclaimed', 'claimed'].includes(v)) throw new Error('獎勵狀態錯誤');
    return { type, mode, value: v };
  }
  return { type, mode, value: value == null ? null : value };
}

const CONDITION_TYPES = new Set([
  'joined_after', 'joined_before', 'is_friend', 'is_blocked', 'tag', 'rich_menu',
  'rich_menu_button', 'liff_event', 'activity', 'invite_count', 'reward_status', 'line_login',
  'activity_enter', 'activity_start', 'activity_complete', 'activity_share', 'successful_invite',
  'follow_event', 'block_event', 'unblock_event',
  'booking_confirmed', 'booking_cancelled',
  'app_registration', 'broadcast_sent', 'broadcast_delivered', 'broadcast_opened', 'broadcast_clicked', 'broadcast_tested', 'broadcast_converted'
]);

function compileAudience(definition) {
  const clean = cleanDefinition(definition);
  const params = [];
  const add = value => { params.push(value); return '$' + params.length; };
  const clauses = clean.conditions.map(c => {
    let sql;
    switch (c.type) {
      case 'joined_after': sql = `(u.created_at AT TIME ZONE 'Asia/Taipei')::date >= ${add(c.value)}::date`; break;
      case 'joined_before': sql = `(u.created_at AT TIME ZONE 'Asia/Taipei')::date <= ${add(c.value)}::date`; break;
      case 'is_friend': sql = `u.blocked_at IS NULL AND u.archived_at IS NULL`; break;
      case 'is_blocked': sql = `u.blocked_at IS NOT NULL`; break;
      case 'tag': sql = `EXISTS (SELECT 1 FROM user_tag_members tm WHERE tm.line_user_id = u.line_user_id AND tm.tag_id = ${add(c.value)} AND (tm.expires_at IS NULL OR tm.expires_at > now()))`; break;
      case 'rich_menu': sql = `EXISTS (SELECT 1 FROM rich_menu_taps rt WHERE rt.line_user_id = u.line_user_id AND rt.menu_id = ${add(c.value)})`; break;
      case 'rich_menu_button': {
        const [menu, tab, cell] = String(c.value).split(':').map(Number);
        sql = `EXISTS (SELECT 1 FROM rich_menu_taps rt WHERE rt.line_user_id=u.line_user_id AND rt.menu_id=${add(menu)} AND rt.tab=${add(tab)} AND rt.cell=${add(cell)})`;
        break;
      }
      case 'liff_event': sql = `EXISTS (SELECT 1 FROM member_liff_events le WHERE le.user_id = u.id AND le.event_name = ${add(c.value)})`; break;
      case 'activity': sql = `EXISTS (SELECT 1 FROM activity_plays ap WHERE ap.line_user_id = u.line_user_id AND ap.activity_id = ${add(c.value)})`; break;
      case 'activity_enter': sql = activityEventSql('enter', add(c.value)); break;
      case 'activity_start': sql = activityEventSql('start', add(c.value)); break;
      case 'activity_complete': sql = activityEventSql('complete', add(c.value)); break;
      case 'activity_share': sql = activityEventSql('share', add(c.value)); break;
      case 'successful_invite': sql = `EXISTS (SELECT 1 FROM activity_referrals ar WHERE ar.inviter_line_user_id=u.line_user_id AND ar.activity_id=${add(c.value)} AND ar.invitee_was_existing IS FALSE)`; break;
      case 'invite_count': sql = `(SELECT COUNT(*) FROM activity_referrals ar WHERE ar.inviter_line_user_id = u.line_user_id AND ar.invitee_was_existing IS FALSE) >= ${add(c.value)}`; break;
      case 'reward_status': sql = rewardSql(c.value); break;
      case 'follow_event': sql = `EXISTS (SELECT 1 FROM line_webhook_events we WHERE we.line_user_id=u.line_user_id AND we.event_type='follow')`; break;
      case 'block_event': sql = `EXISTS (SELECT 1 FROM line_webhook_events we WHERE we.line_user_id=u.line_user_id AND we.event_type='unfollow')`; break;
      case 'unblock_event': sql = `EXISTS (
        SELECT 1 FROM line_webhook_events wf
        WHERE wf.line_user_id=u.line_user_id AND wf.event_type='follow'
          AND EXISTS (SELECT 1 FROM line_webhook_events wu WHERE wu.line_user_id=wf.line_user_id AND wu.event_type='unfollow' AND wu.created_at < wf.created_at)
      )`; break;
      case 'line_login': sql = `EXISTS (SELECT 1 FROM liff_token_probe lp WHERE lp.verified_sub=u.line_user_id AND lp.verified=true)`; break;
      case 'app_registration': sql = `EXISTS (SELECT 1 FROM campaign_phone_registrations pr WHERE pr.line_user_id = u.line_user_id)`; break;
      case 'booking_confirmed': sql = `EXISTS (SELECT 1 FROM gold_pig_bookings gb WHERE gb.line_user_id=u.line_user_id AND gb.status='confirmed')`; break;
      case 'booking_cancelled': sql = `EXISTS (SELECT 1 FROM gold_pig_bookings gb WHERE gb.line_user_id=u.line_user_id AND gb.status IN ('cancellation_requested','cancelled'))`; break;
      case 'broadcast_sent': sql = `EXISTS (SELECT 1 FROM admin_broadcast_recipients br WHERE br.line_user_id = u.line_user_id AND br.broadcast_id = ${add(c.value)} AND br.status = 'sent')`; break;
      case 'broadcast_delivered': sql = `EXISTS (SELECT 1 FROM admin_broadcast_recipients br WHERE br.line_user_id=u.line_user_id AND br.broadcast_id=${add(c.value)} AND br.delivered_at IS NOT NULL)`; break;
      case 'broadcast_opened': sql = `EXISTS (
        SELECT 1 FROM admin_broadcast_recipients br
        WHERE br.line_user_id=u.line_user_id AND br.broadcast_id=${add(c.value)}
          AND (br.opened_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM admin_broadcast_views bv
             WHERE bv.broadcast_id=br.broadcast_id AND bv.recipient_id=br.id
          ))
      )`; break;
      case 'broadcast_clicked': sql = `EXISTS (
        SELECT 1 FROM admin_broadcast_recipients br
        WHERE br.line_user_id=u.line_user_id AND br.broadcast_id=${add(c.value)}
          AND (br.first_clicked_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM admin_broadcast_clicks bc
             WHERE bc.broadcast_id=br.broadcast_id AND bc.recipient_id=br.id
          ))
      )`; break;
      case 'broadcast_tested': sql = `EXISTS (
        SELECT 1 FROM admin_broadcast_recipients br
        JOIN admin_broadcasts b ON b.id = br.broadcast_id
        WHERE br.line_user_id = u.line_user_id AND br.broadcast_id = ${add(c.value)}
          AND br.variant IN ('a','b','c')
          AND (b.is_ab_test = true OR COALESCE((b.audience_config->'experiment'->>'enabled')::boolean, false) = true)
      )`; break;
      case 'broadcast_converted': sql = `EXISTS (SELECT 1 FROM admin_broadcast_clicks bc WHERE bc.line_user_id = u.line_user_id AND bc.broadcast_id = ${add(c.value)})`; break;
      default: throw new Error('不支援的受眾條件');
    }
    return { mode: c.mode, sql };
  });
  const included = clauses.filter(c => c.mode === 'include').map(c => `(${c.sql})`);
  const excluded = clauses.filter(c => c.mode === 'exclude').map(c => `NOT (${c.sql})`);
  const includeSql = included.length ? `(${included.join(clean.operator === 'or' ? ' OR ' : ' AND ')})` : 'TRUE';
  const allSql = [includeSql, ...excluded].join(' AND ');
  return {
    definition: clean,
    params,
    where: allSql,
    sql: `SELECT u.line_user_id
            FROM users u
           WHERE u.line_user_id IS NOT NULL AND BTRIM(u.line_user_id) <> ''
             AND u.is_admin = false
             AND (${allSql})`
  };
}

function rewardSql(status) {
  const got = `EXISTS (SELECT 1 FROM activity_plays ap WHERE ap.line_user_id = u.line_user_id AND COALESCE(ap.prize_snapshot->>'prize_type','none') <> 'none')`;
  const claimed = `EXISTS (SELECT 1 FROM activity_plays ap WHERE ap.line_user_id = u.line_user_id AND COALESCE(ap.prize_snapshot->>'prize_type','none') <> 'none' AND ap.is_redeemed IS TRUE)`;
  const unclaimed = `EXISTS (SELECT 1 FROM activity_plays ap WHERE ap.line_user_id = u.line_user_id AND COALESCE(ap.prize_snapshot->>'prize_type','none') <> 'none' AND COALESCE(ap.is_redeemed,false) IS FALSE)`;
  if (status === 'claimed') return claimed;
  if (status === 'unclaimed') return unclaimed;
  return got;
}

function activityEventSql(name, param) {
  return `EXISTS (SELECT 1 FROM activity_user_events ae WHERE ae.line_user_id=u.line_user_id AND ae.activity_id=${param} AND ae.event_name='${name}')`;
}

async function previewAudience(query, definition, limit = 10) {
  const compiled = compileAudience(definition);
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const count = await query(`SELECT COUNT(*)::int AS n FROM (${compiled.sql}) audience`, compiled.params);
  const sample = await query(
    `SELECT a.line_user_id, COALESCE(u.line_display_name, u.username, '') AS display_name
       FROM (${compiled.sql}) a JOIN users u ON u.line_user_id = a.line_user_id
      ORDER BY u.created_at DESC LIMIT ${safeLimit}`,
    compiled.params
  );
  return { total: Number(count.rows[0] && count.rows[0].n || 0), sample: sample.rows, definition: compiled.definition };
}

async function syncDynamicList(pool, listId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, definition FROM admin_recipient_lists
        WHERE id = $1 AND list_type = 'dynamic' FOR UPDATE`, [listId]);
    if (!locked.rows.length) throw new Error('找不到動態名單');
    const compiled = compileAudience(locked.rows[0].definition);
    await client.query(`DELETE FROM admin_recipient_list_members WHERE list_id = $1`, [listId]);
    const inserted = await client.query(
      `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
       SELECT $${compiled.params.length + 1}, audience.line_user_id FROM (${compiled.sql}) audience
       ON CONFLICT DO NOTHING`, [...compiled.params, listId]);
    await client.query(
      `UPDATE admin_recipient_lists SET total = $2, last_synced_at = now(),
       last_sync_status = 'ok', last_sync_error = NULL, updated_at = now() WHERE id = $1`,
      [listId, inserted.rowCount]);
    await client.query('COMMIT');
    return { total: inserted.rowCount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    await pool.query(
      `UPDATE admin_recipient_lists SET last_synced_at = now(), last_sync_status = 'failed',
       last_sync_error = $2 WHERE id = $1`, [listId, String(err.message || err).slice(0, 500)]).catch(() => {});
    throw err;
  } finally { client.release(); }
}

module.exports = { cleanDefinition, compileAudience, previewAudience, syncDynamicList, CONDITION_TYPES };
