/**
 * 活動 hub 頁面 routes
 *
 * 每個活動都對應一個 hub 頁面（譬如 /admin/campaigns/spring），
 * 在那裡列出該活動相關的所有運營工具。CRM nav 只放一顆 button 進來。
 *
 * 未來新活動時，新建 view + 在這裡加 route 即可，不污染 web.js。
 */

function registerAdminHubRoutes(app, deps) {
  const { authCore, query } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin/campaigns/spring', requireAdmin, (req, res) => {
    return res.render('admin_campaign_spring', {
      title: '春日饗里活動',
      bodyClass: 'admin-shell campaign-hub-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ---------- 旅電借電券（claim 型活動：成效 + 檔期設定，行銷自助） ----------
  // 這頁刻意只開放「看成效」與「檔期/上下架」兩件事，
  // 機率、碼池、LIFF 等工程設定仍在活動管理／優惠券頁，避免誤觸。
  const LUDIAN = {
    slug: 'ludian-0901',
    keywordRuleId: 1,          // 「借電券」關鍵字規則：開放/下架時一併開關
    qaCodePrefix: 'ORTESTQA',  // QA 測試碼：優先發出、不計入成效、上線前清除
    templateId: 31             // 訊息庫「旅電借電券卡片」
  };

  app.get('/admin/campaigns/ludian', requireAdmin, (req, res) => {
    return res.render('admin_campaign_ludian', {
      title: '旅電借電券',
      bodyClass: 'admin-shell campaign-hub-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 成效總覽（QA 測試碼一律排除在數字外）
  app.get('/admin/campaigns/ludian/api/overview', requireAdmin, async (_req, res) => {
    try {
      const { rows: acts } = await query(
        `SELECT id, name, status, start_at, end_at FROM activities WHERE slug = $1 LIMIT 1`,
        [LUDIAN.slug]
      );
      if (acts.length === 0) return res.status(404).json({ ok: false, error: 'activity_not_found' });
      const a = acts[0];
      const qaLike = LUDIAN.qaCodePrefix + '%';

      const { rows: prizeRows } = await query(
        `SELECT id, prize_value FROM activity_prizes
          WHERE activity_id = $1 AND prize_type = 'coupon_code'
          ORDER BY position ASC, id ASC LIMIT 1`,
        [a.id]
      );
      const prizeId = prizeRows.length > 0 ? prizeRows[0].id : null;
      const prizeValue = (prizeRows.length > 0 && prizeRows[0].prize_value) || {};

      const { rows: poolRows } = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'available')::int AS available,
                COUNT(*) FILTER (WHERE status IN ('claimed','redeemed'))::int AS claimed,
                COUNT(*) FILTER (WHERE claimed_at IS NOT NULL
                  AND (claimed_at AT TIME ZONE 'Asia/Taipei')::date = (now() AT TIME ZONE 'Asia/Taipei')::date)::int AS today_claims
           FROM coupon_codes
          WHERE activity_id = $1 AND code NOT LIKE $2`,
        [a.id, qaLike]
      );
      const pool = poolRows[0];

      const { rows: qaRows } = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'available')::int AS available
           FROM coupon_codes
          WHERE activity_id = $1 AND code LIKE $2`,
        [a.id, qaLike]
      );

      const { rows: daily } = await query(
        `SELECT to_char(date_trunc('day', claimed_at AT TIME ZONE 'Asia/Taipei'), 'MM/DD') AS d,
                COUNT(*)::int AS claims
           FROM coupon_codes
          WHERE activity_id = $1 AND claimed_at IS NOT NULL AND code NOT LIKE $2
            AND claimed_at >= now() - interval '30 days'
          GROUP BY date_trunc('day', claimed_at AT TIME ZONE 'Asia/Taipei')
          ORDER BY date_trunc('day', claimed_at AT TIME ZONE 'Asia/Taipei') ASC`,
        [a.id, qaLike]
      );

      // 漏斗：卡片觸發（含同一人重複索取）→ 開啟領取頁（去重）→ 完成領取（去重）→ 點前往兌換（去重）
      const { rows: kwRows } = await query(
        `SELECT COALESCE(hit_count, 0)::int AS hits, is_active, keywords
           FROM admin_keyword_replies WHERE id = $1`,
        [LUDIAN.keywordRuleId]
      );
      const { rows: openRows } = await query(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(verified_sub, ''), body_line_user_id))::int AS opens
           FROM liff_token_probe
          WHERE game_type = 'claim' AND slug = $1 AND endpoint = 'meta'`,
        [LUDIAN.slug]
      );
      const { rows: claimerRows } = await query(
        `SELECT COUNT(DISTINCT claimed_line_user_id)::int AS n
           FROM coupon_codes
          WHERE activity_id = $1 AND claimed_line_user_id IS NOT NULL AND code NOT LIKE $2`,
        [a.id, qaLike]
      );
      const { rows: redeemRows } = await query(
        `SELECT COUNT(DISTINCT line_user_id)::int AS n
           FROM activity_plays
          WHERE activity_id = $1
            AND COALESCE(properties, '{}'::jsonb) ? 'redeem_clicked_at'
            AND (coupon_code IS NULL OR coupon_code NOT LIKE $2)`,
        [a.id, qaLike]
      );

      // 碼量預測：近 7 天平均日領取（QA 排除），推「哪天發完」或「結束時剩多少」
      const { rows: last7Rows } = await query(
        `SELECT COUNT(*)::int AS n FROM coupon_codes
          WHERE activity_id = $1 AND code NOT LIKE $2
            AND claimed_at >= now() - interval '7 days'`,
        [a.id, qaLike]
      );

      // 增粉歸因：活動期間新好友總數 + 領取者中「領取前 24 小時內才加好友」的人數
      const { rows: growthRows } = await query(
        `SELECT
           (SELECT CASE WHEN $1::timestamptz IS NULL THEN NULL ELSE COUNT(*)::int END FROM users
             WHERE archived_at IS NULL AND created_at IS NOT NULL
               AND is_admin = false AND blocked_at IS NULL
               AND line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
               AND ($1::timestamptz IS NULL OR created_at >= $1)
               AND created_at <= LEAST(now(), COALESCE($2::timestamptz, now()))) AS new_friends,
           (SELECT COUNT(DISTINCT c.claimed_line_user_id)::int
              FROM coupon_codes c
              JOIN users u ON u.line_user_id = c.claimed_line_user_id
             WHERE c.activity_id = $3 AND c.claimed_at IS NOT NULL AND c.code NOT LIKE $4
               AND u.created_at IS NOT NULL
               AND u.created_at >= c.claimed_at - interval '24 hours') AS claimers_new`,
        [a.start_at, a.end_at, a.id, qaLike]
      );

      const liffId = (a.liff_id_override && String(a.liff_id_override).trim()) ||
        process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';

      return res.json({
        ok: true,
        activity: a,
        prize_id: prizeId,
        pool,
        qa: qaRows[0],
        daily,
        funnel: {
          card_sends: kwRows.length > 0 ? kwRows[0].hits : 0,
          opens: openRows[0].opens,
          claimers: claimerRows[0].n,
          redeem_clickers: redeemRows[0].n
        },
        forecast: { last7_claims: last7Rows[0].n },
        growth: growthRows[0],
        links: {
          liff_url: liffId ? 'https://liff.line.me/' + liffId + '/claim/' + LUDIAN.slug : '',
          keyword: kwRows.length > 0 ? String(kwRows[0].keywords || '').split(',')[0].trim() : '借電券',
          template_id: LUDIAN.templateId,
          redeem_url: prizeValue.redeem_url || prizeValue.redeem_url_ios || '',
          partner: prizeValue.partner || ''
        },
        keyword_active: kwRows.length > 0 ? !!kwRows[0].is_active : null
      });
    } catch (err) {
      console.error('ludian overview error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'overview_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 檔期設定：開始/結束時間（兩個都必填，結束需晚於開始）
  app.post('/admin/campaigns/ludian/api/window', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const s = new Date(String(body.start_at || ''));
      const e = new Date(String(body.end_at || ''));
      if (isNaN(s.getTime())) return res.status(400).json({ ok: false, error: 'invalid_start', detail: '開始時間格式不正確' });
      if (isNaN(e.getTime())) return res.status(400).json({ ok: false, error: 'invalid_end', detail: '結束時間格式不正確' });
      if (e.getTime() <= s.getTime()) return res.status(400).json({ ok: false, error: 'end_before_start', detail: '結束時間必須晚於開始時間' });
      const { rows } = await query(
        `UPDATE activities SET start_at = $2, end_at = $3, updated_at = now()
          WHERE slug = $1
          RETURNING id, status, start_at, end_at`,
        [LUDIAN.slug, s.toISOString(), e.toISOString()]
      );
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'activity_not_found' });
      return res.json({ ok: true, activity: rows[0] });
    } catch (err) {
      console.error('ludian window error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'window_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 上下架：active=開放（同時開啟關鍵字回覆）；draft=下架（同時關閉關鍵字回覆）
  app.post('/admin/campaigns/ludian/api/status', requireAdmin, async (req, res) => {
    try {
      const status = String((req.body || {}).status || '');
      if (status !== 'active' && status !== 'draft') {
        return res.status(400).json({ ok: false, error: 'invalid_status' });
      }
      const { rows } = await query(
        `UPDATE activities SET status = $2, updated_at = now()
          WHERE slug = $1
          RETURNING id, status, start_at, end_at`,
        [LUDIAN.slug, status]
      );
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'activity_not_found' });
      // 關鍵字回覆跟著開關：下架後輸入「借電券」就不再回卡片
      // 規則可能被刪掉重建（id 會變）：加 keywords 條件避免改到別的規則，
      // 並檢查 rowCount——0 列就誠實回報，不能讓人以為關鍵字也跟著關了
      const kw = await query(
        `UPDATE admin_keyword_replies SET is_active = $2, updated_at = now()
          WHERE id = $1 AND keywords LIKE '%借電%'`,
        [LUDIAN.keywordRuleId, status === 'active']
      );
      const kwOk = kw.rowCount > 0;
      if (!kwOk) console.error('ludian keyword rule not found (id=' + LUDIAN.keywordRuleId + ')');
      return res.json({
        ok: true, activity: rows[0],
        keyword_active: kwOk ? (status === 'active') : null,
        keyword_rule_missing: !kwOk
      });
    } catch (err) {
      console.error('ludian status error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'status_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 客服查詢：輸入完整序號或用戶名稱片段，查領取紀錄
  app.get('/admin/campaigns/ludian/api/lookup', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 100);
      if (q.length < 2) return res.status(400).json({ ok: false, error: 'query_too_short', detail: '至少輸入 2 個字' });
      const { rows: acts } = await query(`SELECT id FROM activities WHERE slug = $1 LIMIT 1`, [LUDIAN.slug]);
      if (acts.length === 0) return res.status(404).json({ ok: false, error: 'activity_not_found' });
      const { rows } = await query(
        `SELECT c.code, c.status, c.claimed_at,
                COALESCE(ap.line_display_name, '') AS display_name,
                (COALESCE(ap.properties, '{}'::jsonb) ? 'redeem_clicked_at') AS redeem_clicked
           FROM coupon_codes c
           LEFT JOIN activity_plays ap ON ap.id = c.claimed_play_id
          WHERE c.activity_id = $1 AND c.claimed_at IS NOT NULL
            AND (UPPER(c.code) = UPPER($2) OR ap.line_display_name ILIKE '%' || regexp_replace($2, '([\\%_])', '\\\\\\1', 'g') || '%')
          ORDER BY c.claimed_at DESC
          LIMIT 20`,
        [acts[0].id, q]
      );
      return res.json({ ok: true, results: rows });
    } catch (err) {
      console.error('ludian lookup error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'lookup_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 清除 QA 測試碼（含測試領取紀錄）。碼池只剩真碼後，之後領的每張都是真的。
  app.post('/admin/campaigns/ludian/api/clear-test-codes', requireAdmin, async (req, res) => {
    try {
      const { rows: acts } = await query(`SELECT id FROM activities WHERE slug = $1 LIMIT 1`, [LUDIAN.slug]);
      if (acts.length === 0) return res.status(404).json({ ok: false, error: 'activity_not_found' });
      const aid = acts[0].id;
      const qaLike = LUDIAN.qaCodePrefix + '%';
      // 先刪碼（解除對 play 的 FK 參照），再刪測試領取紀錄
      const delCodes = await query(
        `DELETE FROM coupon_codes WHERE activity_id = $1 AND code LIKE $2 RETURNING id`,
        [aid, qaLike]
      );
      const delPlays = await query(
        `DELETE FROM activity_plays WHERE activity_id = $1 AND coupon_code LIKE $2 RETURNING id`,
        [aid, qaLike]
      );
      return res.json({ ok: true, removed_codes: delCodes.rows.length, removed_plays: delPlays.rows.length });
    } catch (err) {
      console.error('ludian clear-test-codes error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'clear_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });
}

module.exports = { registerAdminHubRoutes };
