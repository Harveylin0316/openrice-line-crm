'use strict';
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
const { configuredApps, appForTarget, parseReference, parseExecutionReference } = require('../core/broadcastDirectLiff');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');
const { resolveBroadcastButtonTarget } = require('../core/broadcastTemplates');

const HIT_PATH = '/tracking/broadcast/liff-hit';
const EXECUTION_HIT_PATH = '/tracking/execution/liff-hit';
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
}

function createDirectLiffHitHandler({ pool, verifyToken = verifyLiffIdToken, env = process.env }) {
  return async (req, res) => {
    const body = req.body || {};
    const apps = configuredApps(env);
    const app = typeof body.liff_id === 'string' && Object.hasOwn(apps, body.liff_id) ? apps[body.liff_id] : null;
    if (!app || req.get('origin') !== app.origin || body.page_path !== app.pathname) {
      return res.status(403).json({ ok: false, error: 'not_allowed' });
    }
    cors(res, app.origin);
    const ref = parseReference(body.reference);
    if (!ref || body.preview || req.query?.preview === '1' || typeof body.id_token !== 'string' || body.id_token.length > 12000) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    const channelId = channelIdFromLiffId(body.liff_id);
    let verified;
    try { verified = await verifyToken(body.id_token, channelId, { attempts: 1 }); }
    catch (_) { /* Do not log authentication material or provider response. */ }
    if (!verified?.ok || String(verified.aud) !== channelId || !/^U[0-9a-f]{32}$/i.test(verified.sub || '')) {
      return res.status(401).json({ ok: false, error: 'identity_verification_failed' });
    }
    let client, inTransaction = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '3000ms'");
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      // Lock the recipient across duplicate checking, insert and timestamp update.
      // Separate SQL statements after acquiring the lock see the prior commit.
      const rs = await client.query(
        `SELECT b.*, r.line_user_id AS recipient_line_user_id,
                r.status AS recipient_status, r.variant AS recipient_variant
           FROM admin_broadcasts b JOIN admin_broadcast_recipients r ON r.broadcast_id = b.id
          WHERE b.id = $1 AND r.id = $2 FOR UPDATE OF r`,
        [ref.broadcastId, ref.recipientId]
      );
      const row = rs.rows[0];
      const usesVariants = !!(row?.is_ab_test || row?.audience_config?.experiment?.enabled);
      const expectedVariant = usesVariants ? row.recipient_variant : null;
      const cfg = ref.variant === 'b' ? row?.variant_b_message_config :
        ref.variant === 'c' ? row?.audience_config?.experiment?.variantCMessageConfig : row?.message_config;
      const target = cfg && resolveBroadcastButtonTarget(cfg, ref.buttonIndex, { heroImageBaseUrl: app.origin });
      const targetApp = target && appForTarget(target.uri, apps);
      if (!row || row.channel === 'email' || row.recipient_status !== 'sent' ||
          row.recipient_line_user_id !== verified.sub || expectedVariant !== ref.variant || targetApp?.id !== body.liff_id) {
        const error = new Error('not_allowed'); error.status = 403; throw error;
      }
      // Reloads/retries do not fabricate clicks. Existing URL-level uniqueness
      // also coalesces distinct buttons pointing at the exact same destination.
      const recorded = await client.query(
        `WITH inserted AS (
           INSERT INTO admin_broadcast_clicks
             (broadcast_id, recipient_id, line_user_id, target_url, user_agent, variant, button_index, referer)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8
            WHERE NOT EXISTS (
              SELECT 1 FROM admin_broadcast_clicks
               WHERE broadcast_id=$1 AND recipient_id=$2 AND button_index=$7
                 AND variant IS NOT DISTINCT FROM $6)
           ON CONFLICT DO NOTHING
           RETURNING id
         ), updated AS (
           UPDATE admin_broadcast_recipients
              SET first_clicked_at = COALESCE(first_clicked_at, NOW())
            WHERE broadcast_id=$1 AND id=$2 RETURNING id
         ) SELECT EXISTS(SELECT 1 FROM inserted) AS recorded`,
        [ref.broadcastId, ref.recipientId, verified.sub, target.uri,
          (req.get('user-agent') || '').slice(0, 500), ref.variant, ref.buttonIndex, app.endpoint]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return res.json({ ok: true, recorded: recorded.rows[0]?.recorded === true });
    } catch (err) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      return res.status(err.status === 403 ? 403 : 503).json({ ok: false, error: err.status === 403 ? 'not_allowed' : 'tracking_unavailable' });
    } finally { if (client) client.release(); }
  };
}

// 自動化／關鍵字／歡迎訊息直達 LIFF 的回報（or_ex=<執行代碼>.<連結序號>）。
// 規則與群發相同：限定活動網域與路徑、LINE 驗證身分、必須是原收件人且訊息已送達、
// 目的地必須是這個 LIFF。同一則訊息同一顆按鈕每人只記一次（重新整理不會多算）。
function createExecutionLiffHitHandler({ query, verifyToken = verifyLiffIdToken, env = process.env }) {
  return async (req, res) => {
    const body = req.body || {};
    const apps = configuredApps(env);
    const app = typeof body.liff_id === 'string' && Object.hasOwn(apps, body.liff_id) ? apps[body.liff_id] : null;
    if (!app || req.get('origin') !== app.origin || body.page_path !== app.pathname) {
      return res.status(403).json({ ok: false, error: 'not_allowed' });
    }
    cors(res, app.origin);
    const ref = parseExecutionReference(body.reference);
    if (!ref || body.preview || req.query?.preview === '1' || typeof body.id_token !== 'string' || body.id_token.length > 12000) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    const channelId = channelIdFromLiffId(body.liff_id);
    let verified;
    try { verified = await verifyToken(body.id_token, channelId, { attempts: 1 }); }
    catch (_) { /* Do not log authentication material or provider response. */ }
    if (!verified?.ok || String(verified.aud) !== channelId || !/^U[0-9a-f]{32}$/i.test(verified.sub || '')) {
      return res.status(401).json({ ok: false, error: 'identity_verification_failed' });
    }
    try {
      const rs = await query('SELECT * FROM crm_message_executions WHERE code = $1', [ref.code]);
      const execution = rs.rows[0];
      const target = Array.isArray(execution?.targets) ? execution.targets.find(t => t && t.index === ref.index) : null;
      const targetApp = target && appForTarget(String(target.uri || ''), apps);
      if (!execution || execution.test_only || execution.status !== 'accepted' ||
          execution.recipient_key !== verified.sub || targetApp?.id !== body.liff_id) {
        return res.status(403).json({ ok: false, error: 'not_allowed' });
      }
      // 固定的 event_key：同一人、同一則、同一顆按鈕只記第一次
      const key = 'liff-direct:' + crypto.createHash('sha256').update([verified.sub, execution.id, ref.index].join(':')).digest('hex');
      const values = [execution.id, ref.index, verified.sub, key];
      const insert = 'INSERT INTO crm_message_clicks(execution_id,action_index,verified_identity,event_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id';
      const parts = String(execution.source_event_id || '').split(':');
      let recorded;
      if (execution.source_type === 'automation' && parts.length >= 2 && parts.slice(0, 2).every(p => /^[1-9]\d*$/.test(p))) {
        // 同一個語句寫入新點擊與流程「點了連結」分支用的舊紀錄（與 /t/e 中轉頁相同）
        recorded = await query('WITH inserted AS (' + insert + '), legacy AS (INSERT INTO admin_flow_clicks(enrollment_id,line_user_id,message_id,target_url) SELECT $5,$3,$6,$7 FROM inserted) SELECT EXISTS(SELECT 1 FROM inserted) AS recorded',
          [...values, Number(parts[0]), Number(parts[1]), String(target.uri)]);
      } else {
        recorded = await query('WITH inserted AS (' + insert + ') SELECT EXISTS(SELECT 1 FROM inserted) AS recorded', values);
      }
      return res.json({ ok: true, recorded: recorded.rows[0]?.recorded === true });
    } catch (_) {
      return res.status(503).json({ ok: false, error: 'tracking_unavailable' });
    }
  };
}

function registerBroadcastDirectLiffRoutes(app, deps) {
  const env = deps.env || process.env;
  const preflight = (req, res) => {
    const origin = req.get('origin');
    if (!Object.values(configuredApps(env)).some(item => item.origin === origin)) return res.sendStatus(403);
    cors(res, origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  };
  const limiter = () => rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  app.options(HIT_PATH, preflight);
  app.get(HIT_PATH, (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.post(HIT_PATH, limiter(), createDirectLiffHitHandler(deps));
  if (deps.query) {
    app.options(EXECUTION_HIT_PATH, preflight);
    app.get(EXECUTION_HIT_PATH, (_req, res) => res.status(405).set('Allow', 'POST').end());
    app.post(EXECUTION_HIT_PATH, limiter(), createExecutionLiffHitHandler(deps));
  }
}

module.exports = { createDirectLiffHitHandler, createExecutionLiffHitHandler, registerBroadcastDirectLiffRoutes, HIT_PATH, EXECUTION_HIT_PATH };
