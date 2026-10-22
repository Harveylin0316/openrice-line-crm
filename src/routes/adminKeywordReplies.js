/**
 * 關鍵字自動回覆 routes
 *
 * 用戶在 OA 聊天室輸入文字訊息命中關鍵字 → webhook 用 reply token
 * 自動回覆訊息庫（admin_message_templates）的指定訊息。
 *
 *   GET    /admin/keyword-replies                 管理頁
 *   GET    /admin/keyword-replies/api/list        規則列表（含訊息庫下拉選項）
 *   POST   /admin/keyword-replies/api/create      新增
 *   POST   /admin/keyword-replies/api/:id/update  更新（含啟用 toggle）
 *   DELETE /admin/keyword-replies/api/:id         刪除
 */

function registerAdminKeywordRepliesRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }
  function isPosInt(s) {
    return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0;
  }
  /** 全形逗號轉半形、去空白、去空項，存回標準「a, b, c」格式 */
  function normalizeKeywords(raw) {
    return String(raw == null ? '' : raw)
      .replace(/，/g, ',')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .join(', ')
      .slice(0, 500);
  }

  // 頁面
  app.get('/admin/keyword-replies', requireAdmin, (req, res) => {
    res.render('admin_keyword_replies', {
      title: '關鍵字回覆',
      bodyClass: 'admin-shell keyword-replies-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表（一次帶回規則 + 訊息庫下拉選項，前端不用打兩支）
  /**
   * 關鍵字回覆紀錄（依期間）：資料來自 line_webhook_events —— 每次客人的訊息命中規則都會寫一筆，
   * detail 內含「rule#<編號>」、result 為回覆結果。時間用客人傳訊息的時間（event_timestamp），台灣時區、含起訖日。
   *   觸發次數：命中規則的次數（每次都算）；成功回覆：LINE 接受回覆；回覆失敗另計；不重複人數：期間內觸發過的不同客人。
   *   LINE 重送同一事件被擋下（keyword_ab_duplicate_event）不算。
   * granularity：day（每天）、hour（每小時，最多 7 天）、hour_of_day（一天中各時段合計）。
   */
  const KR_RESULTS = ['keyword_replied', 'keyword_fallback_replied', 'keyword_reply_failed', 'keyword_fallback_reply_failed'];
  app.get('/admin/keyword-replies/api/stats', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!ymd.test(from) || !ymd.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return res.status(400).json({ ok: false, error: '日期格式要是 YYYY-MM-DD' });
    }
    if (from > to) return res.status(400).json({ ok: false, error: '開始日期不能晚於結束日期' });
    const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (spanDays > 366) return res.status(400).json({ ok: false, error: '期間最長 366 天' });
    const ruleId = req.query.rule_id ? Number(req.query.rule_id) : null;
    if (req.query.rule_id && !(Number.isInteger(ruleId) && ruleId > 0)) return res.status(400).json({ ok: false, error: '規則編號不正確' });
    const gran = ['day', 'hour', 'hour_of_day'].includes(String(req.query.granularity)) ? String(req.query.granularity) : 'day';
    if (gran === 'hour' && spanDays > 7) return res.status(400).json({ ok: false, error: '「每小時」最多看 7 天，請縮短期間或改看「每天」' });
    const params = [from + 'T00:00:00+08:00', to + 'T00:00:00+08:00', KR_RESULTS];
    const base = `
      WITH ev AS (
        SELECT NULLIF(substring(detail from 'rule#([0-9]+)'), '')::int AS rule_id,
               result, line_user_id, COALESCE(event_timestamp, created_at) AS at
          FROM line_webhook_events
         WHERE event_type = 'message' AND result = ANY($3::text[])
           AND created_at >= $1::timestamptz - INTERVAL '1 day'
           AND created_at <  $2::timestamptz + INTERVAL '2 days'
      ), r AS (
        SELECT * FROM ev
         WHERE rule_id IS NOT NULL
           AND at >= $1::timestamptz AND at < $2::timestamptz + INTERVAL '1 day'
      )`;
    try {
      const totals = (await query(base + `
        SELECT rule_id,
               COUNT(*)::int AS triggers,
               COUNT(*) FILTER (WHERE result IN ('keyword_replied', 'keyword_fallback_replied'))::int AS replied,
               COUNT(*) FILTER (WHERE result IN ('keyword_reply_failed', 'keyword_fallback_reply_failed'))::int AS failed,
               COUNT(DISTINCT line_user_id)::int AS people
          FROM r GROUP BY rule_id`, params)).rows;
      let series = null;
      if (ruleId || req.query.series === 'all') {
        const bucket = gran === 'hour_of_day'
          ? `to_char(at AT TIME ZONE 'Asia/Taipei', 'HH24')`
          : gran === 'hour' ? `to_char(at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24')`
          : `to_char(at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')`;
        series = (await query(base + `
          SELECT ${bucket} AS bucket,
                 COUNT(*)::int AS triggers,
                 COUNT(*) FILTER (WHERE result IN ('keyword_replied', 'keyword_fallback_replied'))::int AS replied,
                 COUNT(DISTINCT line_user_id)::int AS people
            FROM r WHERE ($4::int IS NULL OR rule_id = $4)
           GROUP BY 1 ORDER BY 1`, params.concat([ruleId]))).rows;
      }
      let firstRecordAt = null;
      try {
        firstRecordAt = (await query(
          `SELECT created_at FROM line_webhook_events
            WHERE event_type = 'message' AND result = ANY($1::text[])
            ORDER BY created_at ASC LIMIT 1`, [KR_RESULTS])).rows[0]?.created_at || null;
      } catch (e) { firstRecordAt = null; }
      return res.json({ ok: true, range: { from, to }, granularity: gran, totals, series, first_record_at: firstRecordAt });
    } catch (err) {
      console.error('keyword stats failed:', err && err.message);
      return res.status(503).json({ ok: false, error: '紀錄暫時無法讀取' });
    }
  });

  app.get('/admin/keyword-replies/api/list', requireAdmin, async (_req, res) => {
    try {
      const rules = await query(
        `SELECT r.id, r.keywords, r.match_type, r.message_template_id, r.is_active,
                r.priority, r.hit_count, r.created_at, r.updated_at,
                t.name AS template_name
         FROM admin_keyword_replies r
         LEFT JOIN admin_message_templates t ON t.id = r.message_template_id
         ORDER BY r.priority ASC, r.id ASC`
      );
      const templates = await query(
        `SELECT id, name FROM admin_message_templates
         WHERE COALESCE(channel, 'line') = 'line'
         ORDER BY id DESC`
      );
      // A/B 測試狀態：另外查、失敗就當作沒有（例如 migration 尚未套用），規則清單照常顯示
      let abEnabled = true;
      const abByRule = {};
      try {
        const { effectiveState } = require('../core/keywordExperiments');
        const ab = await query(
          `SELECT DISTINCT ON (rule_id) id, rule_id, name, status, start_at, end_at
             FROM keyword_reply_experiments WHERE rule_id IS NOT NULL
            ORDER BY rule_id, id DESC`
        );
        const now = new Date();
        ab.rows.forEach(e => { abByRule[e.rule_id] = { id: Number(e.id), name: e.name, state: effectiveState(e, now) }; });
      } catch (e) {
        abEnabled = false;
        console.error('keyword experiment status unavailable:', e && e.message);
      }
      return res.json({
        ok: true,
        rules: rules.rows.map(r => Object.assign({}, r, { ab: abByRule[r.id] || null })),
        templates: templates.rows,
        ab_enabled: abEnabled
      });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  async function validateInput(body) {
    // 比對方式：fallback（兜底，沒命中任何關鍵字時回覆）/ exact（完全相同）/ contains（包含，預設）
    const matchType = body.match_type === 'fallback'
      ? 'fallback'
      : (body.match_type === 'exact' ? 'exact' : 'contains');
    // 兜底規則不靠關鍵字，keywords 可留空（存空字串）；其餘比對方式必填關鍵字
    const keywords = normalizeKeywords(body.keywords);
    if (matchType !== 'fallback' && !keywords) return { ok: false, error: 'keywords_required' };
    const templateId = Number(body.message_template_id);
    if (!Number.isInteger(templateId) || templateId <= 0) return { ok: false, error: 'message_template_required' };
    const t = await query(`SELECT id FROM admin_message_templates WHERE id = $1`, [templateId]);
    if (t.rowCount === 0) return { ok: false, error: 'message_template_not_found' };
    const priorityRaw = Number(body.priority);
    const priority = Number.isInteger(priorityRaw) && priorityRaw >= 0 && priorityRaw <= 9999 ? priorityRaw : 100;
    const isActive = body.is_active !== false && body.is_active !== 'false';
    return { ok: true, value: { keywords, matchType, templateId, priority, isActive } };
  }

  // 新增
  app.post('/admin/keyword-replies/api/create', requireAdmin, async (req, res) => {
    try {
      const v = await validateInput(req.body || {});
      if (!v.ok) return jsonErr(res, 400, v.error);
      const rs = await query(
        `INSERT INTO admin_keyword_replies (keywords, match_type, message_template_id, is_active, priority)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count, created_at, updated_at`,
        [v.value.keywords, v.value.matchType, v.value.templateId, v.value.isActive, v.value.priority]
      );
      return res.json({ ok: true, rule: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  // 更新（編輯表單整筆更新；只帶 is_active 時做啟用 toggle）
  app.post('/admin/keyword-replies/api/:id/update', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const body = req.body || {};
      // toggle 模式：body 只帶 is_active
      if (body.keywords === undefined && body.message_template_id === undefined) {
        const isActive = body.is_active === true || body.is_active === 'true';
        const rs = await query(
          `UPDATE admin_keyword_replies SET is_active = $2, updated_at = now()
           WHERE id = $1
           RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count`,
          [Number(idStr), isActive]
        );
        if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
        return res.json({ ok: true, rule: rs.rows[0] });
      }
      const v = await validateInput(body);
      if (!v.ok) return jsonErr(res, 400, v.error);
      const rs = await query(
        `UPDATE admin_keyword_replies
         SET keywords = $2, match_type = $3, message_template_id = $4, is_active = $5, priority = $6, updated_at = now()
         WHERE id = $1
         RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count, created_at, updated_at`,
        [Number(idStr), v.value.keywords, v.value.matchType, v.value.templateId, v.value.isActive, v.value.priority]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, rule: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'update_failed', { detail: err && err.message });
    }
  });

  // 刪除
  app.delete('/admin/keyword-replies/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const rs = await query('DELETE FROM admin_keyword_replies WHERE id = $1 RETURNING id', [Number(idStr)]);
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, deletedId: Number(idStr) });
    } catch (err) {
      return jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminKeywordRepliesRoutes };
