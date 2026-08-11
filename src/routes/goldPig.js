const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');
const { fetchOaProfile, verifyOaFollower } = require('../core/oaFollower');
const { formatDateValue, generateBookingToken, hashBookingToken } = require('../core/goldPigBookings');

function safeEqualText(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function parsePositiveInt(value, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

function buildBookingNo(isDemo) {
  const prefix = isDemo ? 'GPD' : 'GP';
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `${prefix}${date}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function serializeBooking(row) {
  return {
    bookingNo: row.booking_no,
    status: row.status,
    date: formatDateValue(row.session_date),
    time: String(row.session_time || '').slice(0, 5),
    tables4: Number(row.tables_4 || 0),
    tables6: Number(row.tables_6 || 0),
    totalAmount: Number(row.total_amount || 0),
    isDemo: row.is_demo === true
  };
}

function validateBookingInput(body) {
  const date = cleanText(body && body.date, 10);
  const time = cleanText(body && body.time, 5);
  const tables4 = parsePositiveInt(body && body.tables4, 20);
  const tables6 = parsePositiveInt(body && body.tables6, 20);
  const totalAmount = parsePositiveInt(body && body.totalAmount, 1000000);
  const paymentMethod = cleanText(body && body.paymentMethod, 30);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid_date' };
  if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: 'invalid_time' };
  if (tables4 === null || tables6 === null || tables4 + tables6 < 1 || tables4 + tables6 > 2) {
    return { ok: false, error: 'invalid_tables' };
  }
  if (totalAmount === null || totalAmount < 1) return { ok: false, error: 'invalid_amount' };
  return { ok: true, date, time, tables4, tables6, totalAmount, paymentMethod };
}

function registerGoldPigRoutes(app, deps) {
  const {
    pool,
    liffId,
    bookingApiKey,
    demoMode,
    allowedOrigins,
    lineOfficialAddFriendUrl
  } = deps;
  const channelId = channelIdFromLiffId(liffId);
  const originSet = new Set(
    String(allowedOrigins || 'https://twopenrice-ops.github.io,https://tw.openrice.com')
      .split(',')
      .map(value => value.trim().replace(/\/$/, ''))
      .filter(Boolean)
  );
  const bindLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
  });
  const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
  });

  function applyCampaignCors(req, res) {
    const requestOrigin = String(req.get('origin') || '').replace(/\/$/, '');
    if (requestOrigin && originSet.has(requestOrigin)) {
      res.set('Access-Control-Allow-Origin', requestOrigin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Gold-Pig-Api-Key');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    return !requestOrigin || originSet.has(requestOrigin);
  }

  app.options('/api/gold-pig/demo-bookings', (req, res) => {
    if (!applyCampaignCors(req, res)) return res.status(403).end();
    return res.status(204).end();
  });

  async function createBooking(body, isDemo) {
    const valid = validateBookingInput(body);
    if (!valid.ok) return valid;
    const rawToken = generateBookingToken();
    const tokenHash = hashBookingToken(rawToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let inserted;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          inserted = await client.query(
            `INSERT INTO gold_pig_bookings
              (booking_no, status, is_demo, session_date, session_time, tables_4, tables_6,
               guest_count, total_amount, payment_method, payment_reference, contact_name,
               contact_phone, contact_email, paid_at)
             VALUES ($1, 'confirmed', $2, $3::date, $4::time, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
             RETURNING *`,
            [
              buildBookingNo(isDemo), isDemo, valid.date, valid.time, valid.tables4, valid.tables6,
              valid.tables4 * 4 + valid.tables6 * 6, valid.totalAmount, valid.paymentMethod || null,
              isDemo ? null : cleanText(body.paymentReference, 120) || null,
              isDemo ? null : cleanText(body.contactName, 100) || null,
              isDemo ? null : cleanText(body.contactPhone, 40) || null,
              isDemo ? null : cleanText(body.contactEmail, 200).toLowerCase() || null
            ]
          );
          break;
        } catch (err) {
          if (err.code !== '23505' || attempt === 2) throw err;
        }
      }
      const booking = inserted.rows[0];
      await client.query(
        `INSERT INTO gold_pig_booking_tokens (booking_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '72 hours')`,
        [booking.id, tokenHash]
      );
      await client.query('COMMIT');
      const bindUrl = liffId
        ? `https://liff.line.me/${encodeURIComponent(liffId)}/bind?token=${encodeURIComponent(rawToken)}`
        : '';
      return { ok: true, booking: serializeBooking(booking), bindUrl };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  app.post('/api/gold-pig/demo-bookings', createLimiter, async (req, res, next) => {
    try {
      if (!applyCampaignCors(req, res)) return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      if (!demoMode) return res.status(404).json({ ok: false, error: 'demo_disabled' });
      const result = await createBooking(req.body || {}, true);
      return res.status(result.ok ? 201 : 400).json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/gold-pig/bookings', createLimiter, async (req, res, next) => {
    try {
      const provided = req.get('x-gold-pig-api-key') || '';
      if (!bookingApiKey || !safeEqualText(provided, bookingApiKey)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const result = await createBooking(req.body || {}, false);
      return res.status(result.ok ? 201 : 400).json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.get(['/liff/gold-pig', '/liff/gold-pig/*'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.render('gold_pig_liff', {
      liffId: liffId || '',
      addFriendUrl: lineOfficialAddFriendUrl || 'https://line.me/R/ti/p/@openricetw'
    });
  });

  app.post('/api/gold-pig/bind', bindLimiter, async (req, res, next) => {
    const idToken = cleanText(req.body && req.body.idToken, 3000);
    const rawToken = cleanText(req.body && req.body.token, 128);
    if (!/^[a-f0-9]{64}$/i.test(rawToken)) {
      return res.status(400).json({ ok: false, error: 'invalid_booking_link' });
    }
    if (!liffId || !channelId) {
      return res.status(503).json({ ok: false, error: 'liff_not_configured' });
    }
    try {
      const verified = await verifyLiffIdToken(idToken, channelId);
      if (!verified.ok || !verified.sub) {
        return res.status(401).json({ ok: false, error: 'line_login_invalid' });
      }
      const isFollower = await verifyOaFollower(verified.sub);
      if (isFollower === false) {
        return res.status(403).json({ ok: false, error: 'friend_required' });
      }
      if (isFollower !== true) {
        return res.status(503).json({ ok: false, error: 'friend_check_unavailable' });
      }
      const profile = await fetchOaProfile(verified.sub);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tokenResult = await client.query(
          `SELECT t.id AS token_id, t.used_at, t.expires_at, b.*
           FROM gold_pig_booking_tokens t
           JOIN gold_pig_bookings b ON b.id = t.booking_id
           WHERE t.token_hash = $1
           FOR UPDATE OF t, b`,
          [hashBookingToken(rawToken)]
        );
        if (tokenResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ ok: false, error: 'booking_link_not_found' });
        }
        const booking = tokenResult.rows[0];
        if (booking.used_at) {
          if (booking.line_user_id === verified.sub) {
            await client.query('COMMIT');
            return res.json({ ok: true, alreadyBound: true, booking: serializeBooking(booking) });
          }
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, error: 'booking_link_used' });
        }
        if (new Date(booking.expires_at).getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return res.status(410).json({ ok: false, error: 'booking_link_expired' });
        }
        if (booking.line_user_id && booking.line_user_id !== verified.sub) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, error: 'booking_bound_other' });
        }
        await client.query(
          `INSERT INTO users (username, password_hash, line_user_id, line_display_name, line_picture_url, blocked_at, created_at)
           VALUES ($1, '', $2, $3, $4, NULL, now())
           ON CONFLICT (line_user_id) DO UPDATE SET
             line_display_name = COALESCE(EXCLUDED.line_display_name, users.line_display_name),
             line_picture_url = COALESCE(EXCLUDED.line_picture_url, users.line_picture_url),
             blocked_at = NULL`,
          [`line_${verified.sub}`, verified.sub, profile && profile.displayName, profile && profile.pictureUrl]
        );
        await client.query(
          `UPDATE gold_pig_bookings
           SET line_user_id = $1, line_bound_at = now(), updated_at = now()
           WHERE id = $2`,
          [verified.sub, booking.id]
        );
        await client.query('UPDATE gold_pig_booking_tokens SET used_at = now() WHERE id = $1', [booking.token_id]);
        await client.query('COMMIT');
        return res.json({
          ok: true,
          alreadyBound: false,
          booking: serializeBooking({ ...booking, line_user_id: verified.sub })
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = { registerGoldPigRoutes, serializeBooking, validateBookingInput };
