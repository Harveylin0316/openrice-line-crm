'use strict';
/**
 * 關鍵字回覆 A/B 測試：後台 API 與點擊跳板
 *   GET  /admin/keyword-replies/api/:ruleId/experiments          規則的實驗清單＋最新一個的報表
 *   POST /admin/keyword-replies/api/experiments/compare           建立前：兩版預覽、可追蹤連結、差異比對
 *   POST /admin/keyword-replies/api/:ruleId/experiments           建立並開始（內容鎖成快照）
 *   POST /admin/keyword-replies/api/experiments/:id/pause|resume|end|extend
 *   GET  /admin/keyword-replies/api/experiments/:id/report
 *   GET  /t/x/:code、/games/t/x/:code                             點擊跳板（LIFF 取身分 → 記錄 → 導向快照目的地）
 *   POST /t/x/:code/hit、/games/t/x/:code/hit                     伺服器驗證 LINE ID token；點擊者≠收件人不記
 */
const ke = require('../core/keywordExperiments');
const { summarizeConfig } = require('../core/broadcastMessageSnapshot');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');

const DAY_MS = 24 * 3600 * 1000;

function parseTime(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 兩版內容的差異（只列類別），用來提醒「只測封面時其他內容應一致」 */
function compareSummaries(a, b) {
  // 卡片的第一行文字放在 title、其餘在 texts：兩個都要比，標題不同也是「文字不同」
  const textsOf = (x) => [x.title || ''].concat(x.texts || []);
  const pick = (s) => ({
    format: [s.mode].concat((s.segments || []).map(x => (x.summary && x.summary.mode) || x.type)).join('+'),
    notification: s.notificationText || '',
    texts: JSON.stringify(textsOf(s).concat(...(s.segments || []).map(x => textsOf(x.summary || {})))),
    images: JSON.stringify((s.images || []).concat(...(s.segments || []).map(x => (x.summary && x.summary.images) || []))),
    actions: JSON.stringify((s.actions || []).concat(...(s.segments || []).map(x => (x.summary && x.summary.actions) || []))
      .map(x => [x.type, x.label, x.url || x.text || ''])),
  });
  const A = pick(a);
  const B = pick(b);
  const names = { format: '訊息格式／段落', notification: '通知預覽文字', texts: '文字', images: '圖片', actions: '按鈕／連結' };
  const differs = Object.keys(names).filter(k => A[k] !== B[k]).map(k => names[k]);
  return { differs, onlyImages: differs.length === 1 && differs[0] === '圖片' };
}

function registerAdminKeywordExperimentRoutes(app, deps) {
  const { query, authCore, resolvePublicSiteOrigin = () => '', liffIdForTracking = () => '' } = deps;
  const { requireAdmin } = authCore;
  const origin = (req) => String(resolvePublicSiteOrigin(req) || '').replace(/\/+$/, '');
  const jsonErr = (res, status, error, detail) => res.status(status).json({ ok: false, error, detail: detail || error });
  const adminName = (req) => (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';

  async function loadTemplate(id) {
    const { rows } = await query(`SELECT id, name, message_config FROM admin_message_templates WHERE id = $1`, [Number(id)]);
    return rows[0] || null;
  }

  async function prepareVariants(req, aId, bId) {
    const [a, b] = await Promise.all([loadTemplate(aId), loadTemplate(bId)]);
    if (!a || !b) return { error: '找不到選擇的訊息庫素材' };
    for (const [label, t] of [['A 版', a], ['B 版', b]]) {
      const err = ke.validateVariantConfig(t.message_config);
      if (err) return { error: label + '素材無法組成 LINE 回覆：' + err };
      if (t.message_config && t.message_config.channel === 'email') return { error: label + '是 Email 素材，不能用於 LINE 回覆' };
    }
    const o = origin(req);
    const targets = { a: ke.trackableTargets(a.message_config, o), b: ke.trackableTargets(b.message_config, o) };
    const sa = summarizeConfig(a.message_config, { origin: o });
    const sb = summarizeConfig(b.message_config, { origin: o });
    return { a, b, targets, summaries: { a: sa, b: sb }, comparison: compareSummaries(sa, sb) };
  }

  app.post('/admin/keyword-replies/api/experiments/compare', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const out = await prepareVariants(req, body.a_template_id, body.b_template_id);
      if (out.error) return jsonErr(res, 400, 'invalid_variants', out.error);
      return res.json({ ok: true, targets: out.targets, summaries: out.summaries, comparison: out.comparison });
    } catch (err) {
      console.error('keyword experiment compare error:', err && err.message);
      return jsonErr(res, 500, 'compare_failed');
    }
  });

  app.get('/admin/keyword-replies/api/:ruleId(\\d+)/experiments', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT * FROM keyword_reply_experiments WHERE rule_id = $1 ORDER BY id DESC LIMIT 20`,
        [Number(req.params.ruleId)]
      );
      const now = new Date();
      const list = rows.map(e => ({
        id: Number(e.id), name: e.name, state: ke.effectiveState(e, now), start_at: e.start_at, end_at: e.end_at,
        fallback_variant: e.fallback_variant, variant_a_name: e.variant_a_name, variant_b_name: e.variant_b_name,
        attribution_days: e.attribution_days, targets: e.targets, change_log: e.change_log
      }));
      const latestReport = rows[0] ? await ke.experimentReport(query, rows[0], now) : null;
      return res.json({ ok: true, experiments: list, report: latestReport });
    } catch (err) {
      console.error('keyword experiment list error:', err && err.message);
      return jsonErr(res, 500, 'list_failed');
    }
  });

  app.post('/admin/keyword-replies/api/:ruleId(\\d+)/experiments', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const ruleId = Number(req.params.ruleId);
      const rule = (await query(`SELECT id, is_active FROM admin_keyword_replies WHERE id = $1`, [ruleId])).rows[0];
      if (!rule) return jsonErr(res, 404, 'rule_not_found', '找不到關鍵字規則');
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) return jsonErr(res, 400, 'name_required', '請填測試名稱');
      const now = new Date();
      const parsedStart = parseTime(body.start_at);
      if (parsedStart === undefined) return jsonErr(res, 400, 'bad_start', '開始時間格式不正確');
      const startAt = parsedStart || now;
      let endAt = parseTime(body.end_at);
      if (endAt === undefined) return jsonErr(res, 400, 'bad_end', '結束時間格式不正確');
      if (!endAt) {
        const days = Math.floor(Number(body.duration_days || 7));
        if (!(days >= 1 && days <= ke.MAX_DURATION_DAYS)) return jsonErr(res, 400, 'bad_duration', '測試天數要在 1～90 天');
        endAt = new Date(startAt.getTime() + days * DAY_MS);
      }
      if (endAt <= startAt) return jsonErr(res, 400, 'end_before_start', '結束時間必須晚於開始時間');
      if (endAt.getTime() - startAt.getTime() > ke.MAX_DURATION_DAYS * DAY_MS) return jsonErr(res, 400, 'too_long', '測試最長 90 天');
      if (endAt <= now) return jsonErr(res, 400, 'end_in_past', '結束時間已經過了');
      const fallback = body.fallback_variant === 'b' ? 'b' : 'a';
      const prepared = await prepareVariants(req, body.a_template_id, body.b_template_id);
      if (prepared.error) return jsonErr(res, 400, 'invalid_variants', prepared.error);
      // 主要點擊目標：預設各版全部可追蹤連結；只能選快照裡真的有的
      const primary = {};
      for (const v of ['a', 'b']) {
        const valid = prepared.targets[v].map(t => t.index);
        const asked = body.primary && Array.isArray(body.primary[v]) ? body.primary[v].map(Number) : valid;
        primary[v] = asked.filter(i => valid.includes(i));
      }
      const warnings = [];
      if (endAt.getTime() - startAt.getTime() < 7 * DAY_MS) warnings.push('測試未涵蓋完整一週，結果僅供初步參考。');
      if (!prepared.comparison.onlyImages && prepared.comparison.differs.length) warnings.push('A／B 不只封面不同（' + prepared.comparison.differs.join('、') + '），比較結果會混入其他差異。');
      if (!primary.a.length || !primary.b.length) warnings.push('有一版沒有可追蹤的點擊目標，點擊率會顯示「不適用」，無法比較點擊表現。');
      const targets = { a: prepared.targets.a, b: prepared.targets.b, primary };
      const log = [{ at: now.toISOString(), by: adminName(req), action: 'create', start_at: startAt.toISOString(), end_at: endAt.toISOString() }];
      let rows;
      try {
        ({ rows } = await query(
          `WITH expired AS (
             UPDATE keyword_reply_experiments
                SET status = 'ended', ended_at = COALESCE(ended_at, statement_timestamp()),
                    updated_at = statement_timestamp(),
                    change_log = change_log || jsonb_build_array(jsonb_build_object(
                      'action','expire','at',statement_timestamp(),'by',$14::text))
              WHERE rule_id = $1 AND status IN ('running','paused') AND end_at <= statement_timestamp()
              RETURNING id
           )
           INSERT INTO keyword_reply_experiments
             (rule_id, name, status, variant_a_template_id, variant_b_template_id, variant_a_name, variant_b_name,
              variant_a_config, variant_b_config, targets, start_at, end_at, fallback_variant, attribution_days, change_log, created_by)
           SELECT $1,$2,'running',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,7,$13,$14
             FROM (SELECT count(*) FROM expired) AS expiry_barrier
           RETURNING *`,
          [ruleId, name, prepared.a.id, prepared.b.id, prepared.a.name, prepared.b.name,
            JSON.stringify(prepared.a.message_config), JSON.stringify(prepared.b.message_config), JSON.stringify(targets),
            startAt.toISOString(), endAt.toISOString(), fallback, JSON.stringify(log), adminName(req)]
        ));
      } catch (e) {
        if (e && e.code === '23505') return jsonErr(res, 409, 'experiment_open', '這條規則已經有進行中或暫停中的測試，請先結束它');
        throw e;
      }
      return res.json({ ok: true, experiment: rows[0], warnings });
    } catch (err) {
      console.error('keyword experiment create error:', err && err.message);
      return jsonErr(res, 500, 'create_failed');
    }
  });

  async function loadExp(id) {
    const { rows } = await query(`SELECT *, xmin::text AS row_version FROM keyword_reply_experiments WHERE id = $1`, [Number(id)]);
    return rows[0] || null;
  }
  async function saveExp(exp, fields, logEntry) {
    const sets = [];
    const params = [Number(exp.id)];
    Object.keys(fields).forEach(k => { params.push(fields[k]); sets.push(`${k} = $${params.length}`); });
    params.push(exp.status);
    const statusParam = '$' + params.length;
    params.push(exp.row_version);
    const versionParam = '$' + params.length;
    params.push(JSON.stringify([logEntry]));
    sets.push(`change_log = change_log || $${params.length}::jsonb`);
    sets.push('updated_at = now()');
    // Compare-and-set: another tab/admin must not resurrect an ended test or overwrite an extension.
    const { rows } = await query(`UPDATE keyword_reply_experiments SET ${sets.join(', ')}
      WHERE id = $1 AND status = ${statusParam} AND xmin::text = ${versionParam}
        ${logEntry.action === 'end' ? '' : 'AND end_at > statement_timestamp()'} RETURNING *`, params);
    return rows[0];
  }

  app.post('/admin/keyword-replies/api/experiments/:id(\\d+)/:action(pause|resume|end|extend)', requireAdmin, async (req, res) => {
    try {
      const exp = await loadExp(req.params.id);
      if (!exp) return jsonErr(res, 404, 'not_found', '找不到測試');
      const now = new Date();
      const state = ke.effectiveState(exp, now);
      const by = adminName(req);
      const action = req.params.action;
      if (exp.status === 'ended' || (state === 'ended' && action !== 'end')) return jsonErr(res, 400, 'already_ended', '測試已結束，不能再操作；要再測請建立新的測試');
      let updated;
      if (action === 'pause') {
        if (exp.status !== 'running') return jsonErr(res, 400, 'not_running', '只有進行中的測試可以暫停');
        updated = await saveExp(exp, { status: 'paused' }, { at: now.toISOString(), by, action: 'pause' });
      } else if (action === 'resume') {
        if (exp.status !== 'paused') return jsonErr(res, 400, 'not_paused', '只有暫停中的測試可以繼續');
        updated = await saveExp(exp, { status: 'running' }, { at: now.toISOString(), by, action: 'resume' });
      } else if (action === 'end') {
        updated = await saveExp(exp, { status: 'ended', ended_at: now.toISOString() }, { at: now.toISOString(), by, action: 'end' });
      } else {
        const newEnd = parseTime((req.body || {}).end_at);
        if (!newEnd) return jsonErr(res, 400, 'bad_end', '請填新的結束時間');
        if (newEnd <= new Date(exp.end_at)) return jsonErr(res, 400, 'not_extended', '新的結束時間要晚於目前的結束時間');
        if (newEnd.getTime() - new Date(exp.start_at).getTime() > ke.MAX_DURATION_DAYS * DAY_MS) return jsonErr(res, 400, 'too_long', '測試最長 90 天');
        updated = await saveExp(exp, { end_at: newEnd.toISOString() },
          { at: now.toISOString(), by, action: 'extend', from: new Date(exp.end_at).toISOString(), to: newEnd.toISOString() });
      }
      if (!updated) return jsonErr(res, 409, 'state_changed', '測試狀態已變更，請重新整理後再操作');
      return res.json({ ok: true, experiment: updated, state: ke.effectiveState(updated, now) });
    } catch (err) {
      console.error('keyword experiment action error:', err && err.message);
      return jsonErr(res, 500, 'action_failed');
    }
  });

  app.get('/admin/keyword-replies/api/experiments/:id(\\d+)/report', requireAdmin, async (req, res) => {
    try {
      const exp = await loadExp(req.params.id);
      if (!exp) return jsonErr(res, 404, 'not_found', '找不到測試');
      return res.json({ ok: true, report: await ke.experimentReport(query, exp, new Date()) });
    } catch (err) {
      console.error('keyword experiment report error:', err && err.message);
      return jsonErr(res, 500, 'report_failed');
    }
  });

  // ---------- 點擊跳板（公開）----------
  const FALLBACK = 'https://www.openrice.com';
  ['/t/x/:code([A-Za-z0-9_-]+)', '/games/t/x/:code([A-Za-z0-9_-]+)'].forEach(pth => app.get(pth, async (req, res) => {
    try {
      const hit = await ke.resolveClick(query, req.params.code);
      if (!hit) return res.redirect(FALLBACK);
      res.setHeader('Cache-Control', 'no-store');
      return res.render('tap_bounce', {
        target: hit.uri,
        liffId: liffIdForTracking(),
        recordUrl: '/t/x/' + req.params.code + '/hit'
      });
    } catch (e) {
      console.error('keyword experiment bounce error:', e && e.message);
      return res.redirect(FALLBACK);
    }
  }));
  ['/t/x/:code([A-Za-z0-9_-]+)/hit', '/games/t/x/:code([A-Za-z0-9_-]+)/hit'].forEach(pth => app.post(pth, async (req, res) => {
    try {
      const hit = await ke.resolveClick(query, req.params.code);
      if (!hit) return res.json({ ok: true, skipped: true });
      const liffId = liffIdForTracking();
      const v = await verifyLiffIdToken(String((req.body || {}).id_token || ''), channelIdFromLiffId(liffId));
      const out = await ke.recordVerifiedClick(query, hit, v && v.ok ? v.sub : null);
      return res.json({ ok: true, recorded: out.recorded });
    } catch (e) {
      console.error('keyword experiment hit error:', e && e.message);
      return res.json({ ok: true });     // 記錄失敗絕不擋用戶
    }
  }));
}

module.exports = { registerAdminKeywordExperimentRoutes, compareSummaries };
