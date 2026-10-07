'use strict';
/**
 * 關鍵字回覆 A/B 測試
 *
 * 規則（與後台說明一致）
 *   - 每條關鍵字規則可開一個實驗，A／B 各選一則訊息庫素材，50%／50%。
 *   - 建立實驗時就把 A／B 內容與可追蹤連結鎖成快照；之後改訊息庫不影響這個實驗，舊連結仍導向原目的地。
 *   - 同一人在同一實驗內固定同一版（分組表主鍵保證並行也不會重複分組）。
 *   - 每次觸發記一筆回覆紀錄；LINE webhook 重送同一事件（webhookEventId 相同）不會再回、也不膨脹統計。
 *   - LINE Reply API 只有明確 2xx 才算成功；逾時／網路中斷算「結果不確定」，不算成功、不重送。
 *   - 點擊觀察期：從這個人「第一次回覆成功」起算 N 天（預設 7），重複觸發不重算、不延長。
 *   - 點擊只算：經 LINE 登入驗證、而且點擊者就是該次收件人。轉傳給別人點的不算。
 *   - 沒有可辨識的用戶（例如群組內無法取得 userId）→ 照原本規則回覆，不進實驗。
 *   - 尚未開始 → 原本規則；暫停／到期／結束 → 用設定的固定版本（預設 A），不再納入實驗。
 *   - 不自動判定勝出，報表呈現原始人數與比率。
 */

const crypto = require('crypto');
const { buildLineMessages, BROADCAST_WALK_OPTS, validateMessageConfig } = require('./broadcastTemplates');
const { walkUriActions, listUriButtons } = require('./messageTapTracking');

const VARIANTS = ['a', 'b'];
const UID_RE = /^U[0-9a-f]{32}$/i;
const CODE_RE = /^[A-Za-z0-9_-]{16,40}$/;
const MAX_DURATION_DAYS = 90;

/** 實驗目前的實際狀態（依時間推算） */
function effectiveState(exp, now = new Date()) {
  if (!exp || !['running', 'paused', 'ended'].includes(exp.status)) return 'none';
  if (!exp.start_at || !exp.end_at || Number.isNaN(new Date(exp.start_at).getTime()) || Number.isNaN(new Date(exp.end_at).getTime())) return 'none';
  if (exp.status === 'ended') return 'ended';
  const t = now.getTime();
  if (t >= new Date(exp.end_at).getTime()) return 'ended';
  if (exp.status === 'paused') return 'paused';
  if (t < new Date(exp.start_at).getTime()) return 'scheduled';
  return 'running';
}

/**
 * 這一次觸發要怎麼回：
 *   experiment → 進實驗分組；fallback → 用固定版本快照、不進實驗；original → 原本規則素材
 */
function decideReply(exp, { now = new Date(), lineUserId } = {}) {
  const state = effectiveState(exp, now);
  if (state === 'none' || state === 'scheduled') return { mode: 'original', state };
  if (state === 'running') {
    if (!UID_RE.test(String(lineUserId || ''))) return { mode: 'original', state, reason: 'no_user' };
    return { mode: 'experiment', state };
  }
  return { mode: 'fallback', state, variant: exp.fallback_variant === 'b' ? 'b' : 'a' };
}

function variantConfig(exp, variant) {
  return variant === 'b' ? exp.variant_b_config : exp.variant_a_config;
}

/** 可追蹤連結清單（與送出時、點擊反查時同一套走訪規則） */
function trackableTargets(config, origin) {
  const built = buildLineMessages(config, { heroImageBaseUrl: origin || 'https://example.invalid' });
  if (!built.ok) return [];
  return listUriButtons({ contents: built.messages }, BROADCAST_WALK_OPTS)
    .map(b => ({ index: b.index, label: b.label || null, uri: b.uri }));
}

async function findLatestExperiment(query, ruleId) {
  const { rows } = await query(
    `SELECT * FROM keyword_reply_experiments WHERE rule_id = $1 ORDER BY id DESC LIMIT 1`,
    [Number(ruleId)]
  );
  return rows[0] || null;
}

/** 分組：第一次就隨機 50/50，之後固定；並行時以資料庫主鍵為準 */
async function assignVariant(query, experimentId, lineUserId, random = () => crypto.randomInt(2)) {
  const pick = VARIANTS[random() === 1 ? 1 : 0];
  const ins = await query(
    `INSERT INTO keyword_reply_experiment_assignments (experiment_id, line_user_id, variant)
     VALUES ($1, $2, $3)
     ON CONFLICT (experiment_id, line_user_id) DO NOTHING
     RETURNING variant`,
    [experimentId, lineUserId, pick]
  );
  if (ins.rows[0]) return { variant: ins.rows[0].variant, isNew: true };
  const { rows } = await query(
    `SELECT variant FROM keyword_reply_experiment_assignments WHERE experiment_id = $1 AND line_user_id = $2`,
    [experimentId, lineUserId]
  );
  return { variant: rows[0] ? rows[0].variant : pick, isNew: false };
}

/** 先佔一筆回覆紀錄；同一個 webhook 事件第二次進來會回 null（不回覆、不計） */
async function claimDelivery(query, { experimentId, lineUserId, variant, webhookEventId }) {
  const code = crypto.randomBytes(16).toString('base64url');
  const { rows } = await query(
    `INSERT INTO keyword_reply_experiment_deliveries
       (experiment_id, line_user_id, variant, webhook_event_id, delivery_code)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id, delivery_code`,
    [experimentId, lineUserId, variant, webhookEventId ? String(webhookEventId).slice(0, 120) : null, code]
  );
  return rows[0] || null;
}

/** 組出要回覆的訊息；有 LIFF 才把連結換成追蹤跳板（連結只帶隨機代碼，不帶 LINE User ID） */
function buildExperimentMessages(config, { origin, deliveryCode, liffId, targets } = {}) {
  const built = buildLineMessages(config, { heroImageBaseUrl: origin });
  if (!built.ok) return built;
  if (deliveryCode && liffId) {
    walkUriActions({ contents: built.messages },
      (item) => Array.isArray(targets) && !targets.some(t=>t.index===item.index && t.uri===item.uri) ? item.uri : `https://liff.line.me/${liffId}/t/x/${deliveryCode}_${item.index}`, BROADCAST_WALK_OPTS);
  }
  return built;
}

async function finishDelivery(query, delivery, result) {
  const status = ['accepted', 'rejected', 'uncertain'].includes(result && result.status) ? result.status : 'uncertain';
  await query(
    `UPDATE keyword_reply_experiment_deliveries
        SET status = $2, http_status = $3, finished_at = now()
      WHERE id = $1`,
    [delivery.id, status, result && Number.isFinite(Number(result.httpStatus)) ? Number(result.httpStatus) : null]
  );
  if (status === 'accepted') {
    await query(
      `UPDATE keyword_reply_experiment_assignments
          SET first_success_at = COALESCE(first_success_at, now())
        WHERE experiment_id = $1 AND line_user_id = $2`,
      [delivery.experiment_id, delivery.line_user_id]
    );
  }
  return status;
}

/** 點擊跳板：由代碼找回該次回覆與快照目的地（永遠導向快照，不受訊息庫修改影響） */
async function resolveClick(query, codeRaw) {
  const m = /^([A-Za-z0-9_-]+)_(\d{1,3})$/.exec(String(codeRaw || ''));
  if (!m || !CODE_RE.test(m[1])) return null;
  const { rows } = await query(
    `SELECT d.id, d.experiment_id, d.line_user_id, d.variant, e.targets
       FROM keyword_reply_experiment_deliveries d
       JOIN keyword_reply_experiments e ON e.id = d.experiment_id
      WHERE d.delivery_code = $1`,
    [m[1]]
  );
  if (!rows[0]) return null;
  const index = Number(m[2]);
  const list = (rows[0].targets && rows[0].targets[rows[0].variant]) || [];
  const target = list.find(t => Number(t.index) === index);
  if (!target || !/^https?:\/\//i.test(String(target.uri || ''))) return null;
  return { delivery: rows[0], index, uri: target.uri };
}

/** 記點擊：只有驗證過的點擊者＝收件人才記 */
async function recordVerifiedClick(query, hit, verifiedUserId) {
  if (!hit || !UID_RE.test(String(verifiedUserId || ''))) return { recorded: false, reason: 'unverified' };
  if (verifiedUserId !== hit.delivery.line_user_id) return { recorded: false, reason: 'not_recipient' };
  await query(
    `INSERT INTO keyword_reply_experiment_clicks (delivery_id, experiment_id, variant, line_user_id, target_index)
     VALUES ($1, $2, $3, $4, $5)`,
    [hit.delivery.id, hit.delivery.experiment_id, hit.delivery.variant, verifiedUserId, hit.index]
  );
  return { recorded: true };
}

function rate(n, d) {
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10;
}

/**
 * 報表。主要點擊率＝觀察期內點過「主要目標」的不重複人數 ÷ 該版成功回覆的不重複人數。
 *   觀察中：所有成功回覆過的人（數字還會變）
 *   已完成觀察：first_success_at + 觀察天數 ≤ 現在（正式比較用這組）
 *   該版沒有可追蹤的主要目標 → 「不適用」；分母 0 → 「尚無資料」
 */
async function experimentReport(query, exp, now = new Date()) {
  const primary = (exp.targets && exp.targets.primary) || {};
  const out = { experiment_id: Number(exp.id), state: effectiveState(exp, now), attribution_days: exp.attribution_days, variants: {} };
  for (const v of VARIANTS) {
    const prim = (Array.isArray(primary[v]) ? primary[v] : []).map(Number);
    const { rows } = await query(
      `WITH a AS (
         SELECT line_user_id, first_success_at,
                (first_success_at IS NOT NULL AND first_success_at + ($3::int * INTERVAL '1 day') <= $4::timestamptz) AS matured
           FROM keyword_reply_experiment_assignments
          WHERE experiment_id = $1 AND variant = $2
       ),
       d AS (
         SELECT status, line_user_id FROM keyword_reply_experiment_deliveries WHERE experiment_id = $1 AND variant = $2
       ),
       c AS (
         SELECT DISTINCT ON (k.line_user_id) k.line_user_id
           FROM keyword_reply_experiment_clicks k
           JOIN a ON a.line_user_id = k.line_user_id
          WHERE k.experiment_id = $1 AND k.variant = $2
            AND k.target_index = ANY($5::int[])
            AND a.first_success_at IS NOT NULL
            AND k.clicked_at >= a.first_success_at
            AND k.clicked_at < a.first_success_at + ($3::int * INTERVAL '1 day')
       )
       SELECT
         (SELECT COUNT(*) FROM d)::int AS triggers,
         (SELECT COUNT(*) FROM a)::int AS assigned_users,
         (SELECT COUNT(*) FROM d WHERE status = 'accepted')::int AS replies_ok,
         (SELECT COUNT(*) FROM a WHERE first_success_at IS NOT NULL)::int AS reply_users,
         (SELECT COUNT(*) FROM d WHERE status = 'rejected')::int AS replies_failed,
         (SELECT COUNT(*) FROM d WHERE status IN ('uncertain', 'pending'))::int AS replies_uncertain,
         (SELECT COUNT(*) FROM keyword_reply_experiment_clicks k WHERE k.experiment_id = $1 AND k.variant = $2
            AND k.target_index = ANY($5::int[]))::int AS target_clicks,
         (SELECT COUNT(*) FROM c)::int AS clickers,
         (SELECT COUNT(*) FROM a WHERE matured)::int AS matured_users,
         (SELECT COUNT(*) FROM c JOIN a USING (line_user_id) WHERE a.matured)::int AS matured_clickers`,
      [exp.id, v, exp.attribution_days || 7, now.toISOString(), prim]
    );
    const r = rows[0] || {};
    const trackable = prim.length > 0;
    out.variants[v] = {
      name: v === 'b' ? exp.variant_b_name : exp.variant_a_name,
      trackable,
      triggers: r.triggers || 0,
      assigned_users: r.assigned_users || 0,
      replies_ok: r.replies_ok || 0,
      reply_users: r.reply_users || 0,
      replies_failed: r.replies_failed || 0,
      replies_uncertain: r.replies_uncertain || 0,
      target_clicks: trackable ? (r.target_clicks || 0) : null,
      clickers: trackable ? (r.clickers || 0) : null,
      ctr_observing: trackable ? rate(r.clickers || 0, r.reply_users || 0) : null,
      matured_users: r.matured_users || 0,
      matured_clickers: trackable ? (r.matured_clickers || 0) : null,
      ctr_matured: trackable ? rate(r.matured_clickers || 0, r.matured_users || 0) : null
    };
  }
  const A = out.variants.a;
  const B = out.variants.b;
  // 任一版不可比較 → 不給差距，避免「另一版比較好」的錯誤印象
  out.comparable = A.trackable && B.trackable && A.ctr_matured != null && B.ctr_matured != null;
  out.diff_pp_matured = out.comparable ? Math.round((B.ctr_matured - A.ctr_matured) * 10) / 10 : null;
  return out;
}

/** 建立實驗前檢查：兩則素材都要能組成合法的 LINE 回覆 */
function validateVariantConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return '素材內容缺失';
  const v = validateMessageConfig(cfg);
  if (!v.ok) return v.error || '素材內容不完整';
  return null;
}

module.exports = {
  VARIANTS,
  MAX_DURATION_DAYS,
  effectiveState,
  decideReply,
  variantConfig,
  trackableTargets,
  findLatestExperiment,
  assignVariant,
  claimDelivery,
  buildExperimentMessages,
  finishDelivery,
  resolveClick,
  recordVerifiedClick,
  experimentReport,
  validateVariantConfig
};
