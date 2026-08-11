/**
 * 九月訂位抽獎 — 登記名單後台 + 十月出席比對與抽獎。
 *   GET  /admin/booking-reg                頁面
 *   GET  /admin/booking-reg/api/data      統計 + 登記名單 + 已抽出的得獎者
 *   POST /admin/booking-reg/api/match     貼上出席名單（手機）→ 比對出有抽獎資格的人（唯讀）
 *   POST /admin/booking-reg/api/draw      正式抽獎：伺服器端重算資格、隨機抽出、寫進 campaign_draw_winners
 *
 * 抽獎單位是「手機號碼」：一支手機＝一個籤，同一支同一活動只中一次
 * （campaign_draw_winners 的 UNIQUE 擋的），加抽自動排除已中獎的。
 * 抽選用 crypto.randomInt（Math.random 不適合抽獎）。
 */
const crypto = require('crypto');
const { normalizeTwMobile } = require('../core/twPhone');

const CAMPAIGN_KEY = 'sep-booking'; // 必須跟 lineWebhook.js 的 BOOKING_CAMPAIGN_KEY 一致

function registerAdminBookingRegRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin, requireOwner } = authCore;
  function jsonErr(res, s, e, extra = {}) { return res.status(s).json({ ok: false, error: e, ...extra }); }

  /** 貼上的出席名單 → 正規化後的不重複手機清單 + 無效樣本。
   *  分隔符含全形逗號/分號（打全形數字的人符號通常也是全形）；
   *  一整坨黏住的（空格連接、混雜文字）再用「抽出連續號碼」救一層。 */
  function parsePhonesText(text) {
    const parts = String(text || '').split(/[\n\r,;、\t，；]+/).map(x => x.trim()).filter(Boolean);
    const seen = new Set();
    const invalid = [];
    let invalidCount = 0;
    for (const p of parts) {
      const n = normalizeTwMobile(p);
      if (n) { seen.add(n); continue; }
      // 救援：全形轉半形、拿掉夾在號碼裡的分隔符，再抽出所有連續號碼。
      // 這層只對「正常解析失敗的 token」做，例：「王小明 0933-444-555 有訂位」
      const half = p
        .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/[\s\-－–—()（）.]/g, '');
      const runs = half.match(/(?:\+?8869|09)\d{8}/g) || [];
      const got = runs.map(r => normalizeTwMobile(r)).filter(Boolean);
      if (got.length) { got.forEach(x => seen.add(x)); continue; }
      invalidCount++;
      if (invalid.length < 20) invalid.push(p.slice(0, 30));
    }
    return { phones: [...seen], rawCount: parts.length, invalid, invalidCount };
  }

  /** 出席手機 ∩ 登記名單 → 每支手機的登記人（可能多人登記同一支，要標出來讓人裁決） */
  async function matchAttendance(phones) {
    if (phones.length === 0) return [];
    const { rows } = await query(
      `SELECT r.phone_normalized AS phone,
              r.line_user_id,
              r.registered_at,
              COALESCE(u.line_display_name, u.username, '—') AS display_name,
              EXISTS (SELECT 1 FROM campaign_draw_winners w
                       WHERE w.campaign_key = $1 AND w.phone_normalized = r.phone_normalized) AS already_won
         FROM campaign_phone_registrations r
         LEFT JOIN users u ON u.line_user_id = r.line_user_id
        WHERE r.campaign_key = $1 AND r.phone_normalized = ANY($2::text[])
        ORDER BY r.phone_normalized, r.registered_at ASC`,
      [CAMPAIGN_KEY, phones]
    );
    const byPhone = new Map();
    for (const r of rows) {
      if (!byPhone.has(r.phone)) byPhone.set(r.phone, { phone: r.phone, already_won: r.already_won, claimants: [] });
      byPhone.get(r.phone).claimants.push({
        line_user_id: r.line_user_id, display_name: r.display_name, registered_at: r.registered_at
      });
    }
    return [...byPhone.values()];
  }

  /** Fisher–Yates，用 crypto.randomInt（抽獎不能用 Math.random） */
  function cryptoShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  app.get('/admin/booking-reg', requireAdmin, (req, res) => {
    res.render('admin_booking_reg', {
      title: '訂位抽獎登記',
      bodyClass: 'admin-shell bookingreg-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/booking-reg/api/data', requireAdmin, async (_req, res) => {
    try {
      const stats = (await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(DISTINCT line_user_id)::int AS users,
                COUNT(DISTINCT phone_normalized)::int AS phones,
                COUNT(*) FILTER (WHERE registered_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei')::int AS today
           FROM campaign_phone_registrations WHERE campaign_key = $1`,
        [CAMPAIGN_KEY]
      )).rows[0];

      const daily = (await query(
        `SELECT to_char(registered_at AT TIME ZONE 'Asia/Taipei', 'MM/DD') AS d, COUNT(*)::int AS c
           FROM campaign_phone_registrations
          WHERE campaign_key = $1
            AND registered_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Taipei') - interval '13 days') AT TIME ZONE 'Asia/Taipei'
          GROUP BY 1 ORDER BY 1`,
        [CAMPAIGN_KEY]
      )).rows;

      const regs = (await query(
        `SELECT r.phone_normalized AS phone, r.line_user_id, r.registered_at,
                COALESCE(u.line_display_name, u.username, '—') AS display_name,
                (u.line_user_id IS NOT NULL AND u.archived_at IS NULL) AS is_member
           FROM campaign_phone_registrations r
           LEFT JOIN users u ON u.line_user_id = r.line_user_id
          WHERE r.campaign_key = $1
          ORDER BY r.registered_at DESC
          LIMIT 20000`,
        [CAMPAIGN_KEY]
      )).rows;

      const winners = (await query(
        `SELECT w.phone_normalized AS phone, w.line_user_id, w.prize_label, w.draw_batch, w.drawn_at, w.drawn_by,
                COALESCE(u.line_display_name, u.username, '—') AS display_name,
                (SELECT COUNT(DISTINCT r.line_user_id) FROM campaign_phone_registrations r
                  WHERE r.campaign_key = w.campaign_key AND r.phone_normalized = w.phone_normalized) > 1 AS multi_claimant
           FROM campaign_draw_winners w
           LEFT JOIN users u ON u.line_user_id = w.line_user_id
          WHERE w.campaign_key = $1
          ORDER BY w.drawn_at DESC`,
        [CAMPAIGN_KEY]
      )).rows;

      return res.json({ ok: true, stats, daily, regs, regs_truncated: stats.total > regs.length, winners });
    } catch (err) {
      console.error('booking-reg data error:', err && err.message);
      return jsonErr(res, 500, 'data_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/booking-reg/api/match', requireAdmin, async (req, res) => {
    try {
      const { phones, rawCount, invalid, invalidCount } = parsePhonesText((req.body || {}).phones_text);
      const matched = await matchAttendance(phones);
      return res.json({
        ok: true,
        attendance_raw: rawCount,
        attendance_valid: phones.length,
        invalid_samples: invalid,
        invalid_count: invalidCount,
        matched,
        matched_count: matched.length,
        eligible_count: matched.filter(m => !m.already_won).length
      });
    } catch (err) {
      console.error('booking-reg match error:', err && err.message);
      return jsonErr(res, 500, 'match_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/booking-reg/api/draw', requireOwner, async (req, res) => {
    try {
      const body = req.body || {};
      const count = Math.floor(Number(body.count));
      if (!Number.isFinite(count) || count < 1 || count > 500) {
        return jsonErr(res, 400, 'bad_count', { detail: '抽出人數要在 1 到 500 之間' });
      }
      const prizeLabel = String(body.prize_label || '').trim().slice(0, 100) || null;
      const { phones } = parsePhonesText(body.phones_text);
      if (phones.length === 0) return jsonErr(res, 400, 'no_attendance', { detail: '出席名單是空的，先把手機清單貼上來' });

      // 資格一律伺服器端重算，不相信前端傳來的比對結果
      const matched = await matchAttendance(phones);
      const eligible = matched.filter(m => !m.already_won);
      if (eligible.length === 0) return jsonErr(res, 400, 'no_eligible', { detail: '沒有可抽的人（出席名單裡沒有人登記過，或都已經中過獎）' });

      const picked = cryptoShuffle(eligible).slice(0, Math.min(count, eligible.length));
      const batch = 'draw-' + new Date().toISOString().replace(/[:.]/g, '-');
      const drawnBy = String((req.authUser && req.authUser.un) || '').slice(0, 50) || null;

      // 單一 INSERT 原子寫入；同一支手機若在別的視窗剛好也被抽走，UNIQUE 會擋住，
      // RETURNING 回來的才是真的新得獎者。
      const values = [];
      const params = [CAMPAIGN_KEY, batch, prizeLabel, drawnBy];
      picked.forEach((m, i) => {
        // 多人登記同一支手機時，先記最早登記的人；名單上會標註待裁決
        const firstClaimant = m.claimants[0] || {};
        params.push(m.phone, firstClaimant.line_user_id || null);
        const base = 4 + i * 2;
        values.push(`($1, $2, $${base + 1}, $${base + 2}, $3, $4)`);
      });
      const ins = await query(
        `INSERT INTO campaign_draw_winners (campaign_key, draw_batch, phone_normalized, line_user_id, prize_label, drawn_by)
         VALUES ${values.join(', ')}
         ON CONFLICT (campaign_key, phone_normalized) DO NOTHING
         RETURNING phone_normalized AS phone, line_user_id, prize_label, draw_batch, drawn_at`,
        params
      );

      const byPhone = new Map(matched.map(m => [m.phone, m]));
      const winners = ins.rows.map(r => ({
        ...r,
        display_name: (byPhone.get(r.phone) && byPhone.get(r.phone).claimants[0] || {}).display_name || '—',
        multi_claimant: !!(byPhone.get(r.phone) && byPhone.get(r.phone).claimants.length > 1)
      }));

      return res.json({
        ok: true,
        batch,
        requested: count,
        eligible_count: eligible.length,
        // 撞號：同時有另一個視窗在抽，被 UNIQUE 擋掉的名額（不自動補抽，讓人看著補）
        conflicted: picked.length - ins.rows.length,
        winners
      });
    } catch (err) {
      console.error('booking-reg draw error:', err && err.message);
      return jsonErr(res, 500, 'draw_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminBookingRegRoutes };
