'use strict';
// 排程群發「退回草稿」：把一筆群發批次存下來的設定，整理成群發頁可以直接帶回表單的內容。
// 只回傳管理者當初填的設定（訊息、A/B、受眾條件、抽樣、派送遊玩、Email、排程時間），
// 不回傳收件人名單；收件人會在重新預覽時依當下資料重新計算。

function taipeiLocalMinute(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // sv-SE 格式為 "YYYY-MM-DD HH:MM:SS"
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false }).replace(' ', 'T').slice(0, 16);
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function buildDraftFromBroadcast(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const audience = row.audience_config && typeof row.audience_config === 'object' ? row.audience_config : {};
  const experimentRaw = audience.experiment && audience.experiment.enabled === true ? audience.experiment : null;
  const selection = audience.recipientSelection || {};
  const pg = audience.playGrant || null;
  const scheduledAt = row.scheduled_at ? new Date(row.scheduled_at).getTime() : NaN;
  return {
    broadcastId: Number(row.id),
    channel: row.channel === 'email' ? 'email' : 'line',
    message_config: clone(row.message_config) || {},
    is_ab_test: Boolean(row.is_ab_test) && !experimentRaw,
    variant_b_message_config: row.is_ab_test ? clone(row.variant_b_message_config) : null,
    experiment: experimentRaw ? {
      variantCount: experimentRaw.variantCount === 3 ? 3 : 2,
      winnerMode: experimentRaw.winnerMode === 'auto' ? 'auto' : 'manual',
      observationHours: Number(experimentRaw.observationHours) || 24,
      allocations: clone(experimentRaw.allocations) || null,
      variantCMessageConfig: clone(experimentRaw.variantCMessageConfig)
    } : null,
    conditions: clone(audience.conditions) || {},
    recipientSelection: selection.mode === 'random'
      ? { mode: 'random', count: Number(selection.count) || null }
      : { mode: 'all' },
    messageSource: audience.messageSource ? clone(audience.messageSource) : null,
    followupOf: audience.followupOf ? clone(audience.followupOf) : null,
    playGrant: pg ? { activityId: Number(pg.activityId) || null, plays: Number(pg.plays) || null, mode: pg.mode === 'exclusive' ? 'exclusive' : 'additive' } : null,
    email: row.channel === 'email' ? {
      subject: row.email_subject || '',
      fromName: row.email_from_name || '',
      fromAddress: row.email_from_address || ''
    } : null,
    // 原排程時間還沒到才帶回；已過就留空讓管理者重新選
    scheduledAt: Number.isFinite(scheduledAt) && scheduledAt > now + 60 * 1000 ? taipeiLocalMinute(scheduledAt) : null,
    originalScheduledAt: Number.isFinite(scheduledAt) ? taipeiLocalMinute(scheduledAt) : null
  };
}

module.exports = { buildDraftFromBroadcast, taipeiLocalMinute };
