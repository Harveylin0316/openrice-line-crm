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

  // ── 領券頁的文案 ──────────────────────────────────────────
  // 這些字直接印在用戶手機上（大標、說明、注意事項）。原本只存在資料庫裡，
  // 要改得找工程師；現在同事自己就能改，存檔後用戶重新整理就會看到。
  // 清單型欄位在畫面上是「一行一項」，存進資料庫時轉成陣列。
  const LUDIAN_COPY_FIELDS = [
    // ── 標題 ──
    { g: '標題', key: 'page_title',    label: '大標題（還沒領的時候）', type: 'text', max: 40, hint: '打開頁面第一眼看到的字' },
    { g: '標題', key: 'claimed_title', label: '大標題（領完之後）',     type: 'text', max: 40, hint: '領到序號後標題會換成這句' },
    { g: '標題', key: 'tagline',       label: '標題下的一句話',         type: 'text', max: 60, hint: '留空就不顯示' },
    { g: '標題', key: 'ribbon_before', label: '標題上的小標籤（還沒領）', type: 'text', max: 20, hint: '例：LINE 好友限定' },
    { g: '標題', key: 'ribbon_after',  label: '標題上的小標籤（領完後）', type: 'text', max: 20, hint: '例：OPENRICE 好友禮' },

    // ── 按鈕 ──
    { g: '按鈕', key: 'btn_claim',    label: '領取按鈕',         type: 'text', max: 20, hint: '例：領取借電券' },
    { g: '按鈕', key: 'btn_claiming', label: '領取中的按鈕字',   type: 'text', max: 20, hint: '按下去到拿到序號之間顯示' },
    { g: '按鈕', key: 'btn_copy',     label: '複製序號按鈕',     type: 'text', max: 20, hint: '' },
    { g: '按鈕', key: 'btn_redeem',   label: '前往兌換按鈕',     type: 'text', max: 20, hint: '' },
    { g: '按鈕', key: 'code_label',   label: '序號上面的小字',   type: 'text', max: 20, hint: '例：優惠序號' },
    { g: '按鈕', key: 'copied',       label: '複製成功的提示',   type: 'text', max: 20, hint: '複製後跳出來的小字' },
    { g: '按鈕', key: 'copy_failed',  label: '複製失敗的提示',   type: 'text', max: 40, hint: '' },

    // ── 卡片上的說明 ──
    { g: '卡片說明', key: 'claim_note',     label: '領取按鈕下的說明', type: 'text', max: 80, hint: '' },
    { g: '卡片說明', key: 'redeem_note',    label: '兌換按鈕下的說明', type: 'text', max: 80, hint: '' },
    { g: '卡片說明', key: 'redeem_pending', label: '兌換連結還沒開放時', type: 'text', max: 80, hint: '' },
    { g: '卡片說明', key: 'oos_text',       label: '序號發完時顯示',   type: 'text', max: 160,
      hint: '要換行就打 <br>' },

    // ── 展開說明 ──
    { g: '展開說明', key: 'info_link_label',  label: '展開的按鈕文字', type: 'text', max: 20, hint: '' },
    { g: '展開說明', key: 'info_link_close',  label: '收合的按鈕文字', type: 'text', max: 20, hint: '' },
    { g: '展開說明', key: 'sec_how_to_claim', label: '第一段的標題',   type: 'text', max: 20, hint: '例：領取步驟' },
    { g: '展開說明', key: 'how_to_claim',     label: '第一段的內容',   type: 'list', max: 10, hint: '一行一項' },
    { g: '展開說明', key: 'sec_campaign_desc',label: '第二段的標題',   type: 'text', max: 20, hint: '例：活動說明' },
    { g: '展開說明', key: 'campaign_desc',    label: '第二段的內容',   type: 'list', max: 12, hint: '一行一項' },
    { g: '展開說明', key: 'sec_how_to_use',   label: '第三段的標題',   type: 'text', max: 20, hint: '例：使用方式' },
    { g: '展開說明', key: 'how_to_use',       label: '第三段的內容',   type: 'list', max: 12, hint: '一行一項' },
    { g: '展開說明', key: 'sec_tnc',          label: '第四段的標題',   type: 'text', max: 20, hint: '例：注意事項' },
    { g: '展開說明', key: 'tnc',              label: '第四段的內容',   type: 'list', max: 15, hint: '一行一項' },

    // ── 各種狀況的訊息 ──
    { g: '狀況訊息', key: 'loading',    label: '載入中',       type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'err_title',  label: '載不出來（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'err_detail', label: '載不出來（說明）', type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_notstarted_title',  label: '還沒開始（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_notstarted_detail', label: '還沒開始（說明）', type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_ended_title',       label: '已結束（標題）',   type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_ended_detail',      label: '已結束（說明）',   type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_claimed_title',     label: '已經領過（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_claimed_detail',    label: '已經領過（說明）', type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_needfollow_title',  label: '還沒加好友（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_needfollow_detail', label: '還沒加好友（說明）', type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_failed_title',      label: '領取失敗（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_failed_detail',     label: '領取失敗（說明）', type: 'text', max: 60, hint: '' },
    { g: '狀況訊息', key: 'st_neterr_title',      label: '連線出錯（標題）', type: 'text', max: 20, hint: '' },
    { g: '狀況訊息', key: 'st_neterr_detail',     label: '連線出錯（說明）', type: 'text', max: 60, hint: '' }
  ];

  app.get('/admin/campaigns/ludian/api/copy', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT p.id, p.prize_value FROM activity_prizes p
           JOIN activities a ON a.id = p.activity_id
          WHERE a.slug = $1 ORDER BY p.id LIMIT 1`, [LUDIAN.slug]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'prize_not_found' });
      const pv = rows[0].prize_value || {};
      const values = {};
      LUDIAN_COPY_FIELDS.forEach(f => {
        const v = pv[f.key];
        values[f.key] = f.type === 'list'
          ? (Array.isArray(v) ? v.join('\n') : '')
          : (typeof v === 'string' ? v : '');
      });
      res.json({ ok: true, fields: LUDIAN_COPY_FIELDS, values });
    } catch (err) {
      console.error('ludian copy read error:', err && err.message);
      res.status(500).json({ ok: false, error: 'read_failed' });
    }
  });

  app.post('/admin/campaigns/ludian/api/copy', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const { rows } = await query(
        `SELECT p.id, p.prize_value FROM activity_prizes p
           JOIN activities a ON a.id = p.activity_id
          WHERE a.slug = $1 ORDER BY p.id LIMIT 1`, [LUDIAN.slug]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'prize_not_found' });
      // 只覆蓋文案欄位：序號兌換網址、效期那些設定不能被這個表單洗掉
      const pv = Object.assign({}, rows[0].prize_value || {});
      const changed = [];
      for (const f of LUDIAN_COPY_FIELDS) {
        if (!(f.key in body)) continue;
        const raw = String(body[f.key] == null ? '' : body[f.key]);
        if (f.type === 'list') {
          const arr = raw.split('\n').map(x => x.trim()).filter(Boolean).slice(0, f.max);
          if (arr.length) pv[f.key] = arr; else delete pv[f.key];
        } else {
          const t = raw.trim().slice(0, f.max);
          if (t) pv[f.key] = t; else delete pv[f.key];
        }
        changed.push(f.label);
      }
      await query(`UPDATE activity_prizes SET prize_value = $2::jsonb WHERE id = $1`,
        [rows[0].id, JSON.stringify(pv)]);
      res.json({ ok: true, changed });
    } catch (err) {
      console.error('ludian copy save error:', err && err.message);
      res.status(500).json({ ok: false, error: 'save_failed', detail: '存檔失敗，再試一次' });
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
