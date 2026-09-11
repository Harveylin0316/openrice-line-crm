const crypto = require('crypto');
const {
  buildRevisitMessage,
  isHttpUrl,
  isValidEmail,
  normalizeBookingRecord,
  normalizeOfferRecord,
  parseDate,
  renderRevisitHtml,
  renderRevisitText
} = require('../core/revisitEmail');

const MAX_IMPORT_CHUNK = 500;
const MAX_CAMPAIGN_RECIPIENTS = 5000;
const MAX_SEND_BATCH = 20;

function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function positiveInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ctaLabelFor(row) {
  const offer = row && row.offer_snapshot;
  if (offer && offer.offerType === 'set_menu') return '查看套餐並訂位';
  return offer ? '查看優惠並訂位' : '查看餐廳並訂位';
}

function renderRecipientDelivery(row, origin, tokens = {}) {
  const trackingToken = tokens.trackingToken || row.tracking_token;
  const unsubscribeToken = tokens.unsubscribeToken || row.unsubscribe_token;
  const clickUrl = `${origin}/email/revisit/click/${trackingToken}`;
  const unsubscribeUrl = `${origin}/email/revisit/unsubscribe/${unsubscribeToken}`;
  return {
    html: renderRevisitHtml({
      subject: row.subject,
      preheader: row.preheader,
      restaurantName: row.restaurant_name,
      recipientName: row.recipient_name,
      bodyText: row.body_copy,
      ctaUrl: clickUrl,
      ctaLabel: ctaLabelFor(row),
      offer: row.offer_snapshot,
      unsubscribeUrl,
      openPixelUrl: `${origin}/email/revisit/open/${trackingToken}.gif`
    }),
    text: renderRevisitText({
      subject: row.subject,
      recipientName: row.recipient_name,
      bodyText: row.body_copy,
      ctaLabel: ctaLabelFor(row),
      ctaUrl: row.cta_url,
      unsubscribeUrl
    }),
    unsubscribeUrl
  };
}

function isPermanentRecipientFailure(result = {}) {
  const code = Number(result.responseCode || 0);
  const command = String(result.command || '').toUpperCase();
  return code >= 500 && code <= 599 && (command.includes('RCPT') || command.includes('TO'));
}

function jsonError(res, status, error, detail) {
  return res.status(status).json({ ok: false, error, ...(detail ? { detail } : {}) });
}

function isMissingSchemaError(err) {
  return err && (err.code === '42P01' || /revisit_email_/i.test(String(err.message || '')));
}

function schemaError(res, err) {
  if (isMissingSchemaError(err)) {
    return jsonError(res, 503, 'schema_missing', '回訪 Email 資料表尚未建立，請先套用 migration。');
  }
  return jsonError(res, 500, 'data_failed', String(err && err.message ? err.message : err).slice(0, 300));
}

function publicBaseUrl(req, configured, resolvePublicSiteOrigin) {
  const preferred = String(configured || '').trim().replace(/\/+$/, '');
  if (preferred) return preferred;
  return String(resolvePublicSiteOrigin(req) || '').trim().replace(/\/+$/, '');
}

function offerSnapshot(row) {
  if (!row) return null;
  return {
    offerType: row.offer_type,
    title: row.title,
    description: row.description,
    discountLabel: row.discount_label,
    priceLabel: row.price_label,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    terms: row.terms
  };
}

function chooseOffer(offers, restaurantId, asOfDate, minDaysRemaining) {
  const validThrough = addDays(asOfDate, minDaysRemaining);
  const rows = (offers || []).filter((offer) =>
    offer.restaurant_id === restaurantId && offer.is_active === true &&
    parseDate(offer.valid_from) <= asOfDate && parseDate(offer.valid_until) >= validThrough
  );
  const priority = { set_menu: 0, discount: 1, other: 2 };
  rows.sort((a, b) => {
    const p = (priority[a.offer_type] ?? 3) - (priority[b.offer_type] ?? 3);
    if (p !== 0) return p;
    return parseDate(a.valid_until).localeCompare(parseDate(b.valid_until)) || Number(b.id) - Number(a.id);
  });
  return rows[0] || null;
}

function selectEligibleCandidates({
  bookings = [], offers = [], sentRows = [], unsubscribedEmails = [], suppressedEmails = [], settings,
  asOfDate, maxRecipients = MAX_CAMPAIGN_RECIPIENTS
}) {
  const unsubscribed = new Set(unsubscribedEmails.map((email) => String(email).toLowerCase()));
  const suppressed = new Set(suppressedEmails.map((email) => String(email).toLowerCase()));
  const sentBookingIds = new Set(sentRows.map((row) => Number(row.booking_id)));
  const sentByEmail = new Map();
  sentRows.forEach((row) => {
    const email = String(row.recipient_email || '').toLowerCase();
    const list = sentByEmail.get(email) || [];
    list.push(row);
    sentByEmail.set(email, list);
  });
  const excluded = {
    not_due: 0, unsubscribed: 0, suppressed: 0, already_sent: 0,
    restaurant_cooldown: 0, global_cooldown: 0, missing_cta: 0
  };
  const preEligible = [];
  for (const booking of bookings) {
    const email = String(booking.customer_email).toLowerCase();
    const diningDate = parseDate(booking.dining_date);
    if (addDays(diningDate, settings.revisit_after_days) > asOfDate) { excluded.not_due += 1; continue; }
    if (unsubscribed.has(email)) { excluded.unsubscribed += 1; continue; }
    if (suppressed.has(email)) { excluded.suppressed += 1; continue; }
    if (sentBookingIds.has(Number(booking.id))) { excluded.already_sent += 1; continue; }
    const history = sentByEmail.get(email) || [];
    const sameCutoff = addDays(asOfDate, -settings.same_restaurant_cooldown_days);
    if (history.some((row) => row.restaurant_id === booking.restaurant_id && parseDate(row.sent_at) > sameCutoff)) {
      excluded.restaurant_cooldown += 1; continue;
    }
    const globalCutoff = addDays(asOfDate, -settings.global_cooldown_days);
    if (settings.global_cooldown_days > 0 && history.some((row) => parseDate(row.sent_at) > globalCutoff)) {
      excluded.global_cooldown += 1; continue;
    }
    const offer = chooseOffer(offers, booking.restaurant_id, asOfDate, settings.min_offer_days_remaining);
    const targetUrl = offer ? offer.cta_url : booking.booking_url;
    if (!isHttpUrl(targetUrl)) { excluded.missing_cta += 1; continue; }
    preEligible.push({ booking, offer });
  }
  preEligible.sort((a, b) => {
    const priority = { set_menu: 0, discount: 1, other: 2 };
    const offerA = a.offer ? (priority[a.offer.offer_type] ?? 3) : 4;
    const offerB = b.offer ? (priority[b.offer.offer_type] ?? 3) : 4;
    return offerA - offerB || parseDate(b.booking.dining_date).localeCompare(parseDate(a.booking.dining_date));
  });
  const selectedEmails = new Set();
  const eligible = [];
  for (const item of preEligible) {
    const email = String(item.booking.customer_email).toLowerCase();
    if (settings.global_cooldown_days > 0 && selectedEmails.has(email)) {
      excluded.global_cooldown += 1;
      continue;
    }
    selectedEmails.add(email);
    eligible.push(item);
    if (eligible.length >= maxRecipients) break;
  }
  return { eligible, excluded };
}

function registerAdminRevisitEmailRoutes(app, deps) {
  const {
    query, pool, authCore, smtpEmailProvider, resolvePublicSiteOrigin,
    publicBaseUrl: configuredPublicBaseUrl,
    localSendEnabled = false,
    sendIntervalMs = 1500
  } = deps;
  const { requireAdmin, requireOwner } = authCore;

  app.get('/admin/revisit-email', requireAdmin, (req, res) => {
    res.render('admin_revisit_email', {
      title: '訂位客回訪 Email',
      bodyClass: 'admin-shell revisit-email-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      isOwner: authCore.roleOf(req.authUser) === 'admin'
    });
  });

  app.get('/admin/revisit-email/api/data', requireAdmin, async (_req, res) => {
    try {
      const [settings, stats, imports, campaigns, suppressions] = await Promise.all([
        query(`SELECT revisit_after_days, same_restaurant_cooldown_days, global_cooldown_days,
                      min_offer_days_remaining, daily_send_limit, updated_at
                 FROM revisit_email_settings WHERE id = 1`),
        query(`SELECT
          (SELECT COUNT(*)::int FROM revisit_email_bookings) AS bookings,
          (SELECT COUNT(*)::int FROM revisit_email_bookings WHERE booking_status = 'completed' AND marketing_consent) AS eligible_source_bookings,
          (SELECT COUNT(*)::int FROM revisit_email_offers WHERE is_active) AS active_offers,
          (SELECT COUNT(*)::int FROM revisit_email_recipients WHERE status = 'sent') AS sent,
          (SELECT COUNT(*)::int FROM revisit_email_recipients WHERE opened_at IS NOT NULL) AS opened,
          (SELECT COUNT(*)::int FROM revisit_email_recipients WHERE clicked_at IS NOT NULL) AS clicked,
          (SELECT COUNT(*)::int FROM revisit_email_recipients WHERE status = 'needs_review') AS needs_review,
          (SELECT COUNT(*)::int FROM revisit_email_suppressions WHERE active = TRUE) AS suppressed`),
        query(`SELECT id, kind, source_file, status, received_count, accepted_count, rejected_count,
                      error_summary, uploaded_by, completed_at, created_at
                 FROM revisit_email_imports ORDER BY id DESC LIMIT 8`),
        query(`SELECT c.id, c.status, c.as_of_date, c.candidate_count, c.excluded_counts,
                      c.created_by, c.created_at, c.started_at, c.completed_at,
                      c.content_version, c.tested_version, c.last_tested_at, c.last_tested_email,
                      COUNT(r.id)::int AS total,
                      COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
                      COUNT(*) FILTER (WHERE r.status = 'sent')::int AS sent,
                      COUNT(*) FILTER (WHERE r.status = 'needs_review')::int AS needs_review,
                      COUNT(*) FILTER (WHERE r.opened_at IS NOT NULL)::int AS opened,
                      COUNT(*) FILTER (WHERE r.clicked_at IS NOT NULL)::int AS clicked
                 FROM revisit_email_campaigns c
                 LEFT JOIN revisit_email_recipients r ON r.campaign_id = c.id
                GROUP BY c.id ORDER BY c.id DESC LIMIT 12`),
        query(`SELECT id, email, reason, source, detail, created_by, updated_by, updated_at
                 FROM revisit_email_suppressions
                WHERE active = TRUE ORDER BY updated_at DESC LIMIT 50`)
      ]);
      return res.json({
        ok: true,
        settings: settings.rows[0],
        stats: stats.rows[0],
        imports: imports.rows,
        campaigns: campaigns.rows,
        suppressions: suppressions.rows,
        sender: {
          configured: Boolean(smtpEmailProvider && smtpEmailProvider.isConfigured()),
          local_send_enabled: Boolean(localSendEnabled),
          from: smtpEmailProvider && smtpEmailProvider.getDefaultSender ? smtpEmailProvider.getDefaultSender() : null
        }
      });
    } catch (err) {
      console.error('revisit email data error:', err && err.message);
      return schemaError(res, err);
    }
  });

  app.put('/admin/revisit-email/api/settings', requireOwner, async (req, res) => {
    const body = req.body || {};
    const values = {
      revisit: positiveInt(body.revisit_after_days, null, 1, 365),
      same: positiveInt(body.same_restaurant_cooldown_days, null, 1, 730),
      global: positiveInt(body.global_cooldown_days, null, 0, 365),
      offer: positiveInt(body.min_offer_days_remaining, null, 0, 365),
      limit: positiveInt(body.daily_send_limit, null, 1, 1000)
    };
    if (Object.values(values).some((v) => v == null)) return jsonError(res, 400, 'invalid_settings', '設定值超出允許範圍。');
    try {
      const updated = await query(
        `UPDATE revisit_email_settings SET revisit_after_days = $1,
          same_restaurant_cooldown_days = $2, global_cooldown_days = $3,
          min_offer_days_remaining = $4, daily_send_limit = $5,
          updated_by = $6, updated_at = NOW() WHERE id = 1 RETURNING *`,
        [values.revisit, values.same, values.global, values.offer, values.limit, req.authUser.un]
      );
      return res.json({ ok: true, settings: updated.rows[0] });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.post('/admin/revisit-email/api/suppressions', requireOwner, async (req, res) => {
    const body = req.body || {};
    const reason = ['hard_bounce', 'complaint', 'manual'].includes(body.reason) ? body.reason : '';
    const detail = String(body.detail || '').trim().slice(0, 1000) || null;
    const rawEmails = Array.isArray(body.emails) ? body.emails : String(body.emails || '').split(/[\s,;]+/);
    const emails = [...new Set(rawEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))];
    if (!reason || !emails.length || emails.length > 500 || emails.some((email) => !isValidEmail(email))) {
      return jsonError(res, 400, 'invalid_suppressions', '請提供 1–500 個有效 Email，並選擇原因。');
    }
    try {
      const saved = await query(
        `INSERT INTO revisit_email_suppressions
          (email, email_normalized, reason, source, detail, active, created_by, updated_by)
         SELECT email, LOWER(BTRIM(email)), $2, 'admin', $3, TRUE, $4, $4
           FROM UNNEST($1::text[]) AS email
         ON CONFLICT (email_normalized) DO UPDATE SET
           email=EXCLUDED.email, reason=EXCLUDED.reason, source='admin', detail=EXCLUDED.detail,
           active=TRUE, updated_by=EXCLUDED.updated_by, updated_at=NOW()
         RETURNING id`,
        [emails, reason, detail, req.authUser.un]
      );
      return res.json({ ok: true, saved: saved.rowCount });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.delete('/admin/revisit-email/api/suppressions/:id(\\d+)', requireOwner, async (req, res) => {
    try {
      const updated = await query(
        `UPDATE revisit_email_suppressions SET active=FALSE, updated_by=$2, updated_at=NOW()
          WHERE id=$1 AND active=TRUE RETURNING id`,
        [Number(req.params.id), req.authUser.un]
      );
      if (!updated.rowCount) return jsonError(res, 404, 'suppression_not_found');
      return res.json({ ok: true });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.post('/admin/revisit-email/api/imports', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const kind = body.kind === 'offers' ? 'offers' : body.kind === 'bookings' ? 'bookings' : '';
    const filename = String(body.filename || '').trim().slice(0, 240);
    if (!kind || !filename) return jsonError(res, 400, 'invalid_import', '請提供資料類型與檔名。');
    try {
      const created = await query(
        `INSERT INTO revisit_email_imports (kind, source_file, uploaded_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [kind, filename, req.authUser.un]
      );
      return res.json({ ok: true, import_id: created.rows[0].id });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.post('/admin/revisit-email/api/imports/:id(\\d+)/chunk', requireAdmin, async (req, res) => {
    const importId = Number(req.params.id);
    const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
    const confirmedMarketing = req.body && req.body.confirmed_marketing === true;
    if (!records.length) return jsonError(res, 400, 'no_records', '這一批沒有資料。');
    if (records.length > MAX_IMPORT_CHUNK) return jsonError(res, 400, 'chunk_too_large', `每批最多 ${MAX_IMPORT_CHUNK} 筆。`);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const importRs = await client.query(
        `SELECT kind, source_file, status FROM revisit_email_imports WHERE id = $1 FOR UPDATE`, [importId]
      );
      if (!importRs.rowCount) {
        await client.query('ROLLBACK');
        return jsonError(res, 404, 'import_not_found');
      }
      const batch = importRs.rows[0];
      if (batch.status !== 'uploading') {
        await client.query('ROLLBACK');
        return jsonError(res, 409, 'import_closed', '這次上傳已經結束。');
      }
      let accepted = 0;
      const errors = [];
      for (let index = 0; index < records.length; index += 1) {
        const normalized = batch.kind === 'bookings'
          ? normalizeBookingRecord(records[index], { confirmedMarketing })
          : normalizeOfferRecord(records[index]);
        if (!normalized.ok) {
          errors.push({ row: index + 1, errors: normalized.errors.slice(0, 4) });
          continue;
        }
        const v = normalized.value;
        if (batch.kind === 'bookings') {
          await client.query(
            `INSERT INTO revisit_email_bookings
              (source_system, external_booking_id, restaurant_id, restaurant_name,
               customer_email, customer_name, dining_date, booking_status,
               marketing_consent, booking_url, source_file, import_id)
             VALUES ('weekly_csv',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (source_system, external_booking_id) DO UPDATE SET
               restaurant_id = EXCLUDED.restaurant_id, restaurant_name = EXCLUDED.restaurant_name,
               customer_email = EXCLUDED.customer_email, customer_name = EXCLUDED.customer_name,
               dining_date = EXCLUDED.dining_date, booking_status = EXCLUDED.booking_status,
               marketing_consent = EXCLUDED.marketing_consent, booking_url = EXCLUDED.booking_url,
               source_file = EXCLUDED.source_file, import_id = EXCLUDED.import_id, updated_at = NOW()`,
            [v.externalBookingId, v.restaurantId, v.restaurantName, v.customerEmail, v.customerName,
              v.diningDate, v.bookingStatus, v.marketingConsent, v.bookingUrl, batch.source_file, importId]
          );
        } else {
          await client.query(
            `INSERT INTO revisit_email_offers
              (source_system, external_offer_id, restaurant_id, restaurant_name, offer_type,
               title, description, discount_label, price_label, valid_from, valid_until,
               cta_url, terms, is_active, source_file, import_id)
             VALUES ('weekly_csv',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (source_system, external_offer_id) DO UPDATE SET
               restaurant_id = EXCLUDED.restaurant_id, restaurant_name = EXCLUDED.restaurant_name,
               offer_type = EXCLUDED.offer_type, title = EXCLUDED.title,
               description = EXCLUDED.description, discount_label = EXCLUDED.discount_label,
               price_label = EXCLUDED.price_label, valid_from = EXCLUDED.valid_from,
               valid_until = EXCLUDED.valid_until, cta_url = EXCLUDED.cta_url,
               terms = EXCLUDED.terms, is_active = EXCLUDED.is_active,
               source_file = EXCLUDED.source_file, import_id = EXCLUDED.import_id, updated_at = NOW()`,
            [v.externalOfferId, v.restaurantId, v.restaurantName, v.offerType, v.title,
              v.description, v.discountLabel, v.priceLabel, v.validFrom, v.validUntil,
              v.ctaUrl, v.terms, v.isActive, batch.source_file, importId]
          );
        }
        accepted += 1;
      }
      await client.query(
        `UPDATE revisit_email_imports SET
           received_count = received_count + $2,
           accepted_count = accepted_count + $3,
           rejected_count = rejected_count + $4,
           error_summary = (error_summary || $5::jsonb)
         WHERE id = $1`,
        [importId, records.length, accepted, errors.length, JSON.stringify(errors.slice(0, 30))]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, received: records.length, accepted, rejected: errors.length, errors: errors.slice(0, 20) });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('revisit import chunk error:', err && err.message);
      return schemaError(res, err);
    } finally {
      if (client) client.release();
    }
  });

  app.post('/admin/revisit-email/api/imports/:id(\\d+)/finish', requireAdmin, async (req, res) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE revisit_email_imports SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND status = 'uploading'
         RETURNING id, kind, received_count, accepted_count, rejected_count`,
        [Number(req.params.id)]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return jsonError(res, 404, 'import_not_found');
      }
      const batch = updated.rows[0];
      // The weekly offer upload is a full current snapshot. Offers omitted from
      // a successful new snapshot are disabled so expired/withdrawn promotions
      // cannot keep appearing in customer emails.
      if (batch.kind === 'offers' && Number(batch.accepted_count) > 0) {
        await client.query(
          `UPDATE revisit_email_offers SET is_active=FALSE, updated_at=NOW()
            WHERE source_system='weekly_csv' AND import_id IS DISTINCT FROM $1`,
          [Number(req.params.id)]
        );
      }
      await client.query('COMMIT');
      return res.json({ ok: true, import: updated.rows[0] });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return schemaError(res, err);
    } finally {
      if (client) client.release();
    }
  });

  app.post('/admin/revisit-email/api/generate', requireOwner, async (req, res) => {
    const rawAsOfDate = req.body && req.body.as_of_date;
    const asOfDate = parseDate(rawAsOfDate) || taipeiToday();
    if (rawAsOfDate && !parseDate(rawAsOfDate)) {
      return jsonError(res, 400, 'invalid_as_of_date', '計算日期格式不正確。');
    }
    if (asOfDate > taipeiToday()) {
      return jsonError(res, 400, 'future_as_of_date', '不能用未來日期提前寄回訪信。');
    }
    const origin = publicBaseUrl(req, configuredPublicBaseUrl, resolvePublicSiteOrigin);
    if (!isHttpUrl(origin) || !origin.startsWith('https://')) {
      return jsonError(res, 400, 'public_url_required', '請設定 REVISIT_EMAIL_PUBLIC_BASE_URL 為正式 CRM HTTPS 網址，Email 的追蹤與退訂連結才可使用。');
    }
    try {
      const activeCampaign = await query(
        `SELECT 1 FROM revisit_email_campaigns c
          WHERE c.status='sending' AND EXISTS (
            SELECT 1 FROM revisit_email_recipients r
             WHERE r.campaign_id=c.id AND r.status IN ('pending','sending','needs_review'))
          LIMIT 1`
      );
      if (activeCampaign.rowCount) {
        return jsonError(res, 409, 'campaign_still_active', '上一批還有未完成或需人工確認的信件，請先處理完再建立新名單。');
      }
      const settingsRs = await query(`SELECT * FROM revisit_email_settings WHERE id = 1`);
      const settings = settingsRs.rows[0];
      const bookingsRs = await query(
        `SELECT DISTINCT ON (LOWER(customer_email), restaurant_id)
                id, external_booking_id, restaurant_id, restaurant_name, customer_email,
                customer_name, dining_date, booking_url
           FROM revisit_email_bookings
          WHERE booking_status = 'completed' AND marketing_consent = TRUE
          ORDER BY LOWER(customer_email), restaurant_id, dining_date DESC, id DESC
          LIMIT $1`,
        [MAX_CAMPAIGN_RECIPIENTS * 4]
      );
      const bookings = bookingsRs.rows;
      const emails = [...new Set(bookings.map((b) => String(b.customer_email).toLowerCase()))];
      const [unsubRs, suppressionRs, sentRs, offersRs] = await Promise.all([
        emails.length
          ? query(`SELECT LOWER(email) AS email FROM admin_email_unsubscribes WHERE LOWER(email) = ANY($1::text[])`, [emails])
          : Promise.resolve({ rows: [] }),
        emails.length
          ? query(`SELECT email_normalized AS email FROM revisit_email_suppressions
                    WHERE active=TRUE AND email_normalized = ANY($1::text[])`, [emails])
          : Promise.resolve({ rows: [] }),
        emails.length
          ? query(`SELECT booking_id, LOWER(recipient_email) AS recipient_email, restaurant_id, sent_at
                     FROM revisit_email_recipients
                    WHERE status = 'sent' AND LOWER(recipient_email) = ANY($1::text[])`, [emails])
          : Promise.resolve({ rows: [] }),
        query(`SELECT id, restaurant_id, offer_type, title, description, discount_label,
                      price_label, valid_from, valid_until, cta_url, terms, is_active
                 FROM revisit_email_offers WHERE is_active = TRUE ORDER BY id DESC`)
      ]);
      const { eligible, excluded } = selectEligibleCandidates({
        bookings,
        offers: offersRs.rows,
        sentRows: sentRs.rows,
        unsubscribedEmails: unsubRs.rows.map((row) => row.email),
        suppressedEmails: suppressionRs.rows.map((row) => row.email),
        settings,
        asOfDate
      });
      if (!eligible.length) return res.status(400).json({ ok: false, error: 'no_eligible_recipients', excluded_counts: excluded });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE revisit_email_recipients SET status = 'cancelled', updated_at = NOW()
          WHERE status = 'pending' AND campaign_id IN (SELECT id FROM revisit_email_campaigns WHERE status = 'draft')`);
        await client.query(`UPDATE revisit_email_campaigns SET status = 'cancelled', completed_at = NOW()
          WHERE status = 'draft'`);
        const campaignRs = await client.query(
          `INSERT INTO revisit_email_campaigns
            (as_of_date, settings_snapshot, candidate_count, excluded_counts, created_by)
           VALUES ($1,$2::jsonb,$3,$4::jsonb,$5) RETURNING id`,
          [asOfDate, JSON.stringify(settings), bookings.length, JSON.stringify(excluded), req.authUser.un]
        );
        const campaignId = campaignRs.rows[0].id;
        for (const item of eligible) {
          const trackingToken = crypto.randomBytes(24).toString('hex');
          const unsubscribeToken = crypto.randomBytes(24).toString('hex');
          const clickUrl = `${origin}/email/revisit/click/${trackingToken}`;
          const unsubscribeUrl = `${origin}/email/revisit/unsubscribe/${unsubscribeToken}`;
          const openPixelUrl = `${origin}/email/revisit/open/${trackingToken}.gif`;
          const message = buildRevisitMessage({
            restaurantName: item.booking.restaurant_name,
            recipientName: item.booking.customer_name,
            bookingUrl: item.booking.booking_url,
            offer: item.offer,
            clickUrl, unsubscribeUrl, openPixelUrl
          });
          await client.query(
            `INSERT INTO revisit_email_recipients
              (campaign_id, booking_id, offer_id, recipient_email, recipient_name,
               restaurant_id, restaurant_name, offer_snapshot, subject, preheader,
               body_html, body_copy, body_text, cta_url, tracking_token, unsubscribe_token)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [campaignId, item.booking.id, item.offer ? item.offer.id : null,
              item.booking.customer_email, item.booking.customer_name, item.booking.restaurant_id,
              item.booking.restaurant_name, JSON.stringify(offerSnapshot(item.offer)),
              message.subject, message.preheader, message.html, message.bodyText, message.text,
              message.ctaUrl, trackingToken, unsubscribeToken]
          );
        }
        await client.query('COMMIT');
        return res.json({ ok: true, campaign_id: campaignId, recipients: eligible.length, excluded_counts: excluded });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('revisit generate error:', err && err.message);
      return schemaError(res, err);
    }
  });

  app.get('/admin/revisit-email/api/campaigns/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
      const [campaign, recipients] = await Promise.all([
        query(`SELECT * FROM revisit_email_campaigns WHERE id = $1`, [Number(req.params.id)]),
        query(`SELECT id, booking_id, recipient_email, recipient_name, restaurant_id, restaurant_name,
                      offer_snapshot, subject, preheader, body_copy, cta_url, status,
                      failure_detail, sent_at, opened_at, clicked_at, unsubscribed_at
                 FROM revisit_email_recipients WHERE campaign_id = $1 ORDER BY restaurant_name, id LIMIT 5000`, [Number(req.params.id)])
      ]);
      if (!campaign.rowCount) return jsonError(res, 404, 'campaign_not_found');
      return res.json({ ok: true, campaign: campaign.rows[0], recipients: recipients.rows });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.get('/admin/revisit-email/api/recipients/:id(\\d+)/preview', requireAdmin, async (req, res) => {
    try {
      const row = await query(`SELECT body_html FROM revisit_email_recipients WHERE id = $1`, [Number(req.params.id)]);
      if (!row.rowCount) return res.status(404).type('text/plain').send('Not found');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
      return res.type('html').send(row.rows[0].body_html);
    } catch (err) {
      return res.status(500).type('text/plain').send('Preview unavailable');
    }
  });

  app.put('/admin/revisit-email/api/recipients/:id(\\d+)', requireOwner, async (req, res) => {
    const body = req.body || {};
    const subject = String(body.subject || '').trim().slice(0, 200);
    const preheader = String(body.preheader || '').trim().slice(0, 300);
    const bodyText = String(body.body_text || '').trim().slice(0, 4000);
    const ctaUrl = String(body.cta_url || '').trim().slice(0, 1200);
    if (!subject || !bodyText || !isHttpUrl(ctaUrl)) return jsonError(res, 400, 'invalid_content', '主旨、內文與 HTTPS/HTTP CTA 連結都必填。');
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT r.*, c.status AS campaign_status FROM revisit_email_recipients r
         JOIN revisit_email_campaigns c ON c.id = r.campaign_id WHERE r.id = $1 FOR UPDATE OF r, c`, [Number(req.params.id)]
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return jsonError(res, 404, 'recipient_not_found');
      }
      const row = current.rows[0];
      if (row.campaign_status !== 'draft' || row.status !== 'pending') {
        await client.query('ROLLBACK');
        return jsonError(res, 409, 'not_editable', '只有尚未寄送的草稿可以修改。');
      }
      const origin = publicBaseUrl(req, configuredPublicBaseUrl, resolvePublicSiteOrigin);
      if (!isHttpUrl(origin) || !origin.startsWith('https://')) {
        await client.query('ROLLBACK');
        return jsonError(res, 400, 'public_url_required', '正式追蹤網址尚未設定，不能儲存會失效的 Email。');
      }
      const html = renderRevisitHtml({
        subject, preheader, restaurantName: row.restaurant_name, recipientName: row.recipient_name,
        bodyText, ctaUrl: `${origin}/email/revisit/click/${row.tracking_token}`,
        ctaLabel: row.offer_snapshot && row.offer_snapshot.offerType === 'set_menu' ? '查看套餐並訂位' : row.offer_snapshot ? '查看優惠並訂位' : '查看餐廳並訂位',
        offer: row.offer_snapshot,
        unsubscribeUrl: `${origin}/email/revisit/unsubscribe/${row.unsubscribe_token}`,
        openPixelUrl: `${origin}/email/revisit/open/${row.tracking_token}.gif`
      });
      const fullText = renderRevisitText({
        subject, recipientName: row.recipient_name, bodyText,
        ctaLabel: row.offer_snapshot && row.offer_snapshot.offerType === 'set_menu' ? '查看套餐並訂位' : row.offer_snapshot ? '查看優惠並訂位' : '查看餐廳並訂位',
        ctaUrl, unsubscribeUrl: `${origin}/email/revisit/unsubscribe/${row.unsubscribe_token}`
      });
      await client.query(
        `UPDATE revisit_email_recipients SET subject=$2, preheader=$3, body_copy=$4,
          body_text=$5, body_html=$6, cta_url=$7, updated_at=NOW() WHERE id=$1`,
        [Number(req.params.id), subject, preheader, bodyText, fullText, html, ctaUrl]
      );
      await client.query(
        `UPDATE revisit_email_campaigns SET content_version=content_version+1,
          tested_version=NULL, last_tested_at=NULL, last_tested_email=NULL,
          last_test_recipient_id=NULL WHERE id=$1`,
        [row.campaign_id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return schemaError(res, err);
    } finally {
      if (client) client.release();
    }
  });

  app.post('/admin/revisit-email/api/recipients/:id(\\d+)/test', requireOwner, async (req, res) => {
    const testEmail = String(req.body && req.body.test_email || '').trim().toLowerCase();
    if (!isValidEmail(testEmail)) return jsonError(res, 400, 'invalid_test_email');
    if (!localSendEnabled) return jsonError(res, 403, 'local_send_disabled', '測試信只能在已開啟本機寄送的 CRM 執行。');
    if (!smtpEmailProvider || !smtpEmailProvider.isConfigured()) return jsonError(res, 400, 'smtp_not_configured');
    try {
      const origin = publicBaseUrl(req, configuredPublicBaseUrl, resolvePublicSiteOrigin);
      if (!isHttpUrl(origin) || !origin.startsWith('https://')) {
        return jsonError(res, 400, 'public_url_required', '測試信也必須使用正式 HTTPS 追蹤與退訂網址。');
      }
      const rs = await query(
        `SELECT r.*, c.status AS campaign_status, c.content_version
           FROM revisit_email_recipients r
           JOIN revisit_email_campaigns c ON c.id=r.campaign_id
          WHERE r.id=$1`, [Number(req.params.id)]
      );
      if (!rs.rowCount) return jsonError(res, 404, 'recipient_not_found');
      const row = rs.rows[0];
      if (row.campaign_status !== 'draft' || row.status !== 'pending') {
        return jsonError(res, 409, 'test_not_allowed', '只有尚未寄送的草稿可以作為正式寄送測試。');
      }
      const trackingToken = crypto.randomBytes(24).toString('hex');
      const unsubscribeToken = crypto.randomBytes(24).toString('hex');
      const delivery = renderRecipientDelivery(row, origin, { trackingToken, unsubscribeToken });
      const testRs = await query(
        `INSERT INTO revisit_email_test_deliveries
          (campaign_id, recipient_id, test_email, content_version, tracking_token,
           unsubscribe_token, cta_url, tested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [row.campaign_id, row.id, testEmail, row.content_version, trackingToken,
          unsubscribeToken, row.cta_url, req.authUser.un]
      );
      const testId = testRs.rows[0].id;
      const sent = await smtpEmailProvider.sendEmail({
        to: testEmail,
        subject: `[測試] ${row.subject}`,
        html: delivery.html,
        text: delivery.text,
        headers: {
          'X-OpenRice-Revisit-Test': String(testId),
          'List-Unsubscribe': `<${delivery.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      });
      if (!sent.ok) {
        await query(
          `UPDATE revisit_email_test_deliveries SET status='failed', failure_detail=$2, updated_at=NOW()
            WHERE id=$1`, [testId, String(sent.error || 'smtp_send_failed').slice(0, 1500)]
        );
        return jsonError(res, 502, 'smtp_send_failed', sent.error);
      }
      await query(
        `WITH accepted AS (
           UPDATE revisit_email_test_deliveries
              SET status='sent', provider_message_id=$2, sent_at=NOW(), failure_detail=NULL, updated_at=NOW()
            WHERE id=$1 AND status='pending' RETURNING campaign_id, recipient_id, test_email, content_version
         )
         UPDATE revisit_email_campaigns c
            SET tested_version=a.content_version, last_tested_at=NOW(),
                last_tested_email=a.test_email, last_test_recipient_id=a.recipient_id
           FROM accepted a
          WHERE c.id=a.campaign_id AND c.status='draft' AND c.content_version=a.content_version`,
        [testId, sent.messageId || null]
      );
      return res.json({ ok: true, message_id: sent.messageId || null });
    } catch (err) {
      return schemaError(res, err);
    }
  });

  app.post('/admin/revisit-email/api/smtp/verify', requireOwner, async (_req, res) => {
    if (!localSendEnabled) return jsonError(res, 403, 'local_send_disabled');
    if (!smtpEmailProvider || !smtpEmailProvider.isConfigured()) return jsonError(res, 400, 'smtp_not_configured');
    const result = await smtpEmailProvider.verify();
    return result.ok ? res.json({ ok: true }) : jsonError(res, 502, 'smtp_verify_failed', result.error);
  });

  app.post('/admin/revisit-email/api/campaigns/:id(\\d+)/send', requireOwner, async (req, res) => {
    if (!localSendEnabled) return jsonError(res, 403, 'local_send_disabled', '正式寄送只能在 Mac 本機明確開啟 REVISIT_EMAIL_LOCAL_SEND_ENABLED=1 後執行。');
    if (!smtpEmailProvider || !smtpEmailProvider.isConfigured()) return jsonError(res, 400, 'smtp_not_configured');
    const campaignId = Number(req.params.id);
    const requested = positiveInt(req.body && req.body.limit, 10, 1, MAX_SEND_BATCH);
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      return schemaError(res, err);
    }
    let claimed = [];
    let dailyRemaining = 0;
    try {
      await client.query('BEGIN');
      const campaignRs = await client.query(
        `SELECT status, content_version, tested_version, last_tested_at
           FROM revisit_email_campaigns WHERE id=$1 FOR UPDATE`, [campaignId]
      );
      if (!campaignRs.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return jsonError(res, 404, 'campaign_not_found');
      }
      if (!['draft', 'sending'].includes(campaignRs.rows[0].status)) {
        await client.query('ROLLBACK');
        client.release();
        return jsonError(res, 409, 'campaign_not_sendable', '這個批次已完成或取消，不能再次寄送。');
      }
      if (!campaignRs.rows[0].last_tested_at ||
          Number(campaignRs.rows[0].tested_version) !== Number(campaignRs.rows[0].content_version)) {
        await client.query('ROLLBACK');
        client.release();
        return jsonError(res, 409, 'successful_test_required', '請先寄出目前版本的測試信；修改任何草稿後都要重新測試。');
      }
      // A browser/process may disappear after SMTP accepted a message but
      // before the result was stored. Never retry such rows automatically.
      await client.query(
        `UPDATE revisit_email_recipients SET status='needs_review',
                failure_detail='previous_send_interrupted_check_sent_folder', updated_at=NOW()
          WHERE campaign_id=$1 AND status='sending' AND updated_at < NOW() - INTERVAL '15 minutes'`,
        [campaignId]
      );
      // Lock the singleton row so two clicks cannot both consume the same
      // remaining daily quota.
      const settingsRs = await client.query(`SELECT daily_send_limit FROM revisit_email_settings WHERE id=1 FOR UPDATE`);
      const sentTodayRs = await client.query(
        `SELECT COUNT(*)::int AS count FROM revisit_email_recipients
          WHERE (status='sent' AND (sent_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date)
             OR (status='sending' AND (updated_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date)`
      );
      dailyRemaining = Math.max(0, Number(settingsRs.rows[0].daily_send_limit) - Number(sentTodayRs.rows[0].count));
      if (dailyRemaining === 0) {
        await client.query('ROLLBACK');
        client.release();
        return jsonError(res, 409, 'daily_limit_reached', '今天的寄送上限已用完。');
      }
      const take = Math.min(requested, dailyRemaining);
      await client.query(
        `UPDATE revisit_email_recipients r SET status='skipped', failure_detail='unsubscribed_before_send', updated_at=NOW()
          WHERE r.campaign_id=$1 AND r.status='pending' AND EXISTS
            (SELECT 1 FROM admin_email_unsubscribes u WHERE LOWER(u.email)=LOWER(r.recipient_email))`, [campaignId]
      );
      await client.query(
        `UPDATE revisit_email_recipients r SET status='skipped', failure_detail='suppressed_before_send', updated_at=NOW()
          WHERE r.campaign_id=$1 AND r.status='pending' AND EXISTS
            (SELECT 1 FROM revisit_email_suppressions s
              WHERE s.active=TRUE AND s.email_normalized=LOWER(r.recipient_email))`, [campaignId]
      );
      const claimRs = await client.query(
        `WITH picked AS (
           SELECT r.id FROM revisit_email_recipients r
            WHERE r.campaign_id=$1 AND r.status='pending'
              AND NOT EXISTS (SELECT 1 FROM revisit_email_recipients sent
                WHERE sent.booking_id=r.booking_id AND sent.status='sent')
            ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE revisit_email_recipients r SET status='sending', updated_at=NOW()
          FROM picked WHERE r.id=picked.id RETURNING r.*`,
        [campaignId, take]
      );
      claimed = claimRs.rows;
      if (claimed.length) await client.query(`UPDATE revisit_email_campaigns SET status='sending', started_at=COALESCE(started_at,NOW()) WHERE id=$1 AND status='draft'`, [campaignId]);
      await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      client.release();
      return schemaError(res, err);
    }
    client.release();
    if (!claimed.length) {
      const states = await query(
        `SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                COUNT(*) FILTER (WHERE status IN ('sending','needs_review'))::int AS unresolved
           FROM revisit_email_recipients WHERE campaign_id=$1`, [campaignId]
      );
      if (Number(states.rows[0].pending) === 0 && Number(states.rows[0].unresolved) === 0) {
        await query(`UPDATE revisit_email_campaigns SET status='completed', completed_at=COALESCE(completed_at,NOW()) WHERE id=$1`, [campaignId]);
      }
      return res.json({
        ok: true, claimed: 0, sent: 0, needs_review: Number(states.rows[0].unresolved),
        pending: Number(states.rows[0].pending), daily_remaining: dailyRemaining
      });
    }
    let sentCount = 0;
    let reviewCount = 0;
    let failedCount = 0;
    const origin = publicBaseUrl(req, configuredPublicBaseUrl, resolvePublicSiteOrigin);
    for (let index = 0; index < claimed.length; index += 1) {
      const row = claimed[index];
      let result;
      try {
        result = await smtpEmailProvider.sendEmail({
          to: row.recipient_email,
          toName: row.recipient_name || undefined,
          subject: row.subject,
          html: row.body_html,
          text: row.body_text,
          headers: {
            'X-OpenRice-Revisit-ID': String(row.id),
            ...(isHttpUrl(origin) ? {
              'List-Unsubscribe': `<${origin}/email/revisit/unsubscribe/${row.unsubscribe_token}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            } : {})
          }
        });
      } catch (err) {
        result = { ok: false, error: String(err && err.message ? err.message : err) };
      }
      if (result.ok) {
        try {
          const stored = await query(
            `UPDATE revisit_email_recipients SET status='sent', provider_message_id=$2,
              sent_at=NOW(), failure_detail=NULL, updated_at=NOW() WHERE id=$1 AND status='sending'`,
            [row.id, result.messageId || null]
          );
          if (stored.rowCount) sentCount += 1;
        } catch (err) {
          reviewCount += 1;
          await query(
            `UPDATE revisit_email_recipients SET status='needs_review',
              failure_detail='smtp_accepted_but_result_store_failed', updated_at=NOW()
              WHERE id=$1 AND status='sending'`, [row.id]
          ).catch(() => {});
          console.error('revisit email result store error:', row.id, err && err.message);
        }
      } else if (isPermanentRecipientFailure(result)) {
        failedCount += 1;
        let failureClient;
        try {
          failureClient = await pool.connect();
          await failureClient.query('BEGIN');
          const detail = String(result.error || 'smtp_permanent_recipient_rejection').slice(0, 1500);
          await failureClient.query(
            `INSERT INTO revisit_email_suppressions
              (email, email_normalized, reason, source, detail, active, created_by, updated_by)
             VALUES ($1,LOWER(BTRIM($1)),'hard_bounce','smtp_rejection',$2,TRUE,'system','system')
             ON CONFLICT (email_normalized) DO UPDATE SET reason='hard_bounce', source='smtp_rejection',
               detail=EXCLUDED.detail, active=TRUE, updated_by='system', updated_at=NOW()`,
            [row.recipient_email, detail]
          );
          await failureClient.query(
            `UPDATE revisit_email_recipients SET status='failed', failure_detail=$2, updated_at=NOW()
              WHERE id=$1 AND status='sending'`, [row.id, detail]
          );
          await failureClient.query(
            `INSERT INTO revisit_email_recipient_events
              (recipient_id, campaign_id, event_type, detail, acted_by)
             VALUES ($1,$2,'auto_hard_bounce',$3::jsonb,'system')`,
            [row.id, campaignId, JSON.stringify({ responseCode: result.responseCode || null, command: result.command || null })]
          );
          await failureClient.query('COMMIT');
        } catch (err) {
          if (failureClient) await failureClient.query('ROLLBACK').catch(() => {});
          reviewCount += 1;
          failedCount -= 1;
          await query(
            `UPDATE revisit_email_recipients SET status='needs_review', failure_detail=$2, updated_at=NOW()
              WHERE id=$1 AND status IN ('sending','failed')`,
            [row.id, 'hard_bounce_store_failed:' + String(err && err.message ? err.message : err).slice(0, 1200)]
          ).catch(() => {});
        } finally {
          if (failureClient) failureClient.release();
        }
      } else {
        reviewCount += 1;
        await query(
          `UPDATE revisit_email_recipients SET status='needs_review', failure_detail=$2,
            updated_at=NOW() WHERE id=$1 AND status='sending'`,
          [row.id, String(result.error || 'smtp_send_failed').slice(0, 1500)]
        ).catch((err) => console.error('revisit email failure store error:', row.id, err && err.message));
      }
      if (index < claimed.length - 1 && sendIntervalMs > 0) await sleep(sendIntervalMs);
    }
    const remainingRs = await query(
      `SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='needs_review')::int AS needs_review
         FROM revisit_email_recipients WHERE campaign_id=$1`, [campaignId]
    );
    const remaining = remainingRs.rows[0];
    if (Number(remaining.pending) === 0 && Number(remaining.needs_review) === 0) {
      await query(`UPDATE revisit_email_campaigns SET status='completed', completed_at=NOW() WHERE id=$1`, [campaignId]);
    }
    return res.json({
      ok: true, claimed: claimed.length, sent: sentCount, failed: failedCount, needs_review: reviewCount,
      pending: Number(remaining.pending), daily_remaining: Math.max(0, dailyRemaining - sentCount)
    });
  });

  app.post('/admin/revisit-email/api/campaigns/:id(\\d+)/retry-review', requireOwner, async (req, res) => {
    return jsonError(res, 410, 'bulk_review_disabled', '為避免誤重寄，請逐封確認寄送結果。');
  });

  app.post('/admin/revisit-email/api/recipients/:id(\\d+)/review', requireOwner, async (req, res) => {
    const action = String(req.body && req.body.action || '');
    if (!['confirm_sent', 'retry', 'cancel'].includes(action)) {
      return jsonError(res, 400, 'invalid_review_action');
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, campaign_id, status, failure_detail
           FROM revisit_email_recipients WHERE id=$1 FOR UPDATE`, [Number(req.params.id)]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return jsonError(res, 404, 'recipient_not_found');
      }
      const row = found.rows[0];
      if (row.status !== 'needs_review') {
        await client.query('ROLLBACK');
        return jsonError(res, 409, 'review_not_required', '這封信目前不是需人工確認狀態。');
      }
      const eventType = {
        confirm_sent: 'manual_confirm_sent', retry: 'manual_retry', cancel: 'manual_cancel'
      }[action];
      const nextStatus = { confirm_sent: 'sent', retry: 'pending', cancel: 'cancelled' }[action];
      await client.query(
        `UPDATE revisit_email_recipients SET status=$2,
          sent_at=CASE WHEN $2='sent' THEN COALESCE(sent_at,updated_at,NOW()) ELSE sent_at END,
          failure_detail=CASE
            WHEN $2='pending' THEN NULL
            WHEN $2='sent' THEN 'manually_confirmed_sent'
            ELSE 'manually_cancelled_after_review'
          END,
          updated_at=NOW() WHERE id=$1`,
        [row.id, nextStatus]
      );
      await client.query(
        `INSERT INTO revisit_email_recipient_events
          (recipient_id, campaign_id, event_type, detail, acted_by)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [row.id, row.campaign_id, eventType, JSON.stringify({ previousFailure: row.failure_detail || null }), req.authUser.un]
      );
      const unresolved = await client.query(
        `SELECT COUNT(*)::int AS count FROM revisit_email_recipients
          WHERE campaign_id=$1 AND status IN ('pending','sending','needs_review')`, [row.campaign_id]
      );
      if (Number(unresolved.rows[0].count) === 0) {
        await client.query(
          `UPDATE revisit_email_campaigns SET status='completed', completed_at=COALESCE(completed_at,NOW())
            WHERE id=$1 AND status IN ('draft','sending')`, [row.campaign_id]
        );
      }
      await client.query('COMMIT');
      return res.json({ ok: true, status: nextStatus });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return schemaError(res, err);
    } finally {
      if (client) client.release();
    }
  });

  app.get('/email/revisit/open/:token([a-f0-9]{48}).gif', async (req, res) => {
    try {
      const tracked = await query(`UPDATE revisit_email_recipients SET opened_at=COALESCE(opened_at,NOW()), updated_at=NOW()
        WHERE tracking_token=$1 AND status='sent'`, [req.params.token]);
      if (!tracked.rowCount) {
        await query(`UPDATE revisit_email_test_deliveries SET opened_at=COALESCE(opened_at,NOW()), updated_at=NOW()
          WHERE tracking_token=$1 AND status='sent'`, [req.params.token]);
      }
    } catch (_) { /* tracking must not break the image response */ }
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.type('image/gif').send(gif);
  });

  app.get('/email/revisit/click/:token([a-f0-9]{48})', async (req, res) => {
    try {
      const found = await query(`SELECT id, cta_url FROM revisit_email_recipients WHERE tracking_token=$1`, [req.params.token]);
      if (found.rowCount && isHttpUrl(found.rows[0].cta_url)) {
        await query(`UPDATE revisit_email_recipients SET clicked_at=COALESCE(clicked_at,NOW()), updated_at=NOW() WHERE id=$1`, [found.rows[0].id]);
        return res.redirect(found.rows[0].cta_url);
      }
      const testFound = await query(`SELECT id, cta_url FROM revisit_email_test_deliveries WHERE tracking_token=$1`, [req.params.token]);
      if (!testFound.rowCount || !isHttpUrl(testFound.rows[0].cta_url)) return res.redirect('https://tw.openrice.com/');
      await query(`UPDATE revisit_email_test_deliveries SET clicked_at=COALESCE(clicked_at,NOW()), updated_at=NOW() WHERE id=$1`, [testFound.rows[0].id]);
      return res.redirect(testFound.rows[0].cta_url);
    } catch (_) {
      return res.redirect('https://tw.openrice.com/');
    }
  });

  app.get('/email/revisit/unsubscribe/:token([a-f0-9]{48})', async (req, res) => {
    try {
      const found = await query(`SELECT restaurant_name FROM revisit_email_recipients WHERE unsubscribe_token=$1`, [req.params.token]);
      if (!found.rowCount) {
        const testFound = await query(`SELECT id FROM revisit_email_test_deliveries WHERE unsubscribe_token=$1`, [req.params.token]);
        if (!testFound.rowCount) return res.status(404).type('text/plain').send('這個退訂連結無效或已過期。');
        return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f5f3ef;font-family:system-ui,-apple-system,sans-serif;color:#3e2c23"><main style="max-width:520px;margin:64px auto;padding:32px;background:#fff;border-top:8px solid #f9c73b;border-radius:16px"><h1 style="margin-top:0">測試退訂頁正常</h1><p style="line-height:1.7">這是測試信，沒有客戶會被退訂。正式信會在此要求收件人再次確認。</p></main></body>`);
      }
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="margin:0;background:#f5f3ef;font-family:system-ui,-apple-system,sans-serif;color:#3e2c23"><main style="max-width:520px;margin:64px auto;padding:32px;background:#fff;border-top:8px solid #f9c73b;border-radius:16px"><h1 style="margin-top:0">停止接收回訪 Email</h1><p style="line-height:1.7">確認後，這個 Email 地址將不再收到 OpenRice 的餐廳回訪訊息。</p><form method="post"><button style="border:0;border-radius:10px;background:#f9c73b;color:#3e2c23;font-weight:800;font-size:16px;padding:14px 22px;cursor:pointer">確認退訂</button></form></main></body>`);
    } catch (_) {
      return res.status(500).type('text/plain').send('目前無法處理，請稍後再試。');
    }
  });

  app.post('/email/revisit/unsubscribe/:token([a-f0-9]{48})', async (req, res) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const found = await client.query(`SELECT id, recipient_email, campaign_id FROM revisit_email_recipients WHERE unsubscribe_token=$1 FOR UPDATE`, [req.params.token]);
      if (!found.rowCount) {
        const testFound = await client.query(`SELECT id FROM revisit_email_test_deliveries WHERE unsubscribe_token=$1 FOR UPDATE`, [req.params.token]);
        if (testFound.rowCount) {
          await client.query('COMMIT');
          return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f5f3ef;font-family:system-ui,-apple-system,sans-serif;color:#3e2c23"><main style="max-width:520px;margin:64px auto;padding:32px;background:#fff;border-top:8px solid #f9c73b;border-radius:16px"><h1 style="margin-top:0">測試完成</h1><p style="line-height:1.7">退訂流程可開啟；這是測試信，沒有修改任何客戶名單。</p></main></body>`);
        }
        await client.query('ROLLBACK');
        return res.status(404).type('text/plain').send('這個退訂連結無效或已過期。');
      }
      const row = found.rows[0];
      await client.query(
        `INSERT INTO admin_email_unsubscribes (email, broadcast_id, reason)
         VALUES (LOWER($1), NULL, 'revisit_email')
         ON CONFLICT (email) DO UPDATE SET reason='revisit_email'`, [row.recipient_email]
      );
      await client.query(`UPDATE revisit_email_recipients SET unsubscribed_at=COALESCE(unsubscribed_at,NOW()), updated_at=NOW() WHERE LOWER(recipient_email)=LOWER($1)`, [row.recipient_email]);
      await client.query('COMMIT');
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f5f3ef;font-family:system-ui,-apple-system,sans-serif;color:#3e2c23"><main style="max-width:520px;margin:64px auto;padding:32px;background:#fff;border-top:8px solid #f9c73b;border-radius:16px"><h1 style="margin-top:0">已完成退訂</h1><p style="line-height:1.7">之後不會再收到 OpenRice 的餐廳回訪 Email。</p></main></body>`);
    } catch (_) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return res.status(500).type('text/plain').send('目前無法處理，請稍後再試。');
    } finally {
      if (client) client.release();
    }
  });
}

module.exports = {
  MAX_IMPORT_CHUNK,
  MAX_SEND_BATCH,
  addDays,
  chooseOffer,
  isPermanentRecipientFailure,
  registerAdminRevisitEmailRoutes,
  renderRecipientDelivery,
  selectEligibleCandidates,
  taipeiToday
};
