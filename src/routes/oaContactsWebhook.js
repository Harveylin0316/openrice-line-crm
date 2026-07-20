/**
 * 第二個 LINE OA（新 provider）的「只收集 userId」webhook。
 *
 * 與主 OA 的 /webhooks/line 完全隔離：
 *   - 用自己的 channel secret 驗簽（LINE2_CHANNEL_SECRET）
 *   - 用自己的 access token 抓暱稱/大頭貼（LINE2_CHANNEL_ACCESS_TOKEN）
 *   - 只寫進 oa_contacts（以 oa_key 命名空間），不碰 users 表、不發任何訊息、不觸發任何流程
 *
 * 為什麼不能共用 users：跨 provider 的 userId 是不同命名空間，同一個人在兩個 OA 的 userId 不同，
 * 混進 users.line_user_id 會撞唯一索引、污染群發名單與邀請歸因。
 *
 * 掛載：app.post('/webhooks/line2', express.raw({type:'application/json'}), createOaContactsWebhookHandler({...}))
 */
const crypto = require('crypto');

function safeEqualBase64(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createOaContactsWebhookHandler({ pool, channelSecret, channelAccessToken, oaKey = 'oa2' }) {
  async function fetchProfile(userId) {
    if (!channelAccessToken) return null;
    try {
      const resp = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
        headers: { Authorization: 'Bearer ' + channelAccessToken }
      });
      if (!resp.ok) return null;
      const j = await resp.json().catch(() => null);
      if (!j) return null;
      return { displayName: j.displayName || null, pictureUrl: j.pictureUrl || null };
    } catch (e) {
      console.error('[oa2] fetchProfile failed:', e && e.message);
      return null;
    }
  }

  const PROFILE_RETRY_MS = 24 * 60 * 60 * 1000; // profile 抓失敗後最多一天重試一次

  // 收錄一位聯絡人：upsert 進 oa_contacts；若還沒暱稱且最近沒試過才補抓 profile。
  // 先寫 profile_tried_at 再抓，避免抓失敗後「每則訊息都重打一次 profile API」的風暴。
  async function captureContact(userId) {
    await pool.query(
      `INSERT INTO oa_contacts (oa_key, line_user_id, first_seen_at, last_event_at, blocked_at)
       VALUES ($1, $2, now(), now(), NULL)
       ON CONFLICT (oa_key, line_user_id) DO UPDATE SET last_event_at = now(), blocked_at = NULL`,
      [oaKey, userId]
    );
    if (!channelAccessToken) return;
    const r = await pool.query(
      'SELECT display_name, profile_tried_at FROM oa_contacts WHERE oa_key = $1 AND line_user_id = $2',
      [oaKey, userId]
    );
    const row = r.rows[0];
    if (!row || row.display_name) return; // 已有暱稱就不用抓
    const triedAt = row.profile_tried_at ? new Date(row.profile_tried_at).getTime() : 0;
    if (triedAt && Date.now() - triedAt < PROFILE_RETRY_MS) return; // 最近試過，先別再打
    // 先標記「試過了」，再抓；抓失敗也不會在下一則訊息立刻重打
    await pool.query(
      'UPDATE oa_contacts SET profile_tried_at = now() WHERE oa_key = $1 AND line_user_id = $2',
      [oaKey, userId]
    );
    const prof = await fetchProfile(userId);
    if (prof && (prof.displayName || prof.pictureUrl)) {
      await pool.query(
        `UPDATE oa_contacts SET display_name = COALESCE($3, display_name),
           picture_url = COALESCE($4, picture_url)
         WHERE oa_key = $1 AND line_user_id = $2`,
        [oaKey, userId, prof.displayName, prof.pictureUrl]
      );
    }
  }

  return async function oaContactsWebhookHandler(req, res) {
    try {
      if (!channelSecret) {
        return res.status(500).send('Missing LINE2 channel secret');
      }
      const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const rawBody = rawBodyBuffer.toString('utf8');
      const expectedSignature = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
      const incomingSignature = req.get('x-line-signature') || '';
      if (!safeEqualBase64(expectedSignature, incomingSignature)) {
        return res.status(401).send('Invalid signature');
      }

      const payload = JSON.parse(rawBody || '{}');
      const events = Array.isArray(payload.events) ? payload.events : [];

      for (const event of events) {
        const userId = event && event.source && event.source.userId;
        if (!userId) continue;
        try {
          if (event.type === 'unfollow') {
            await pool.query(
              'UPDATE oa_contacts SET blocked_at = now() WHERE oa_key = $1 AND line_user_id = $2',
              [oaKey, userId]
            );
            continue;
          }
          // follow / message / 其他有 userId 的事件都當作「收錄這個人」
          await captureContact(userId);
        } catch (e) {
          // 單一事件失敗不影響整批：仍回 200，避免 LINE 重送整批
          console.error('[oa2] capture failed:', e && e.message);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[oa2] webhook error:', err && err.message);
      return res.status(200).json({ ok: false });
    }
  };
}

module.exports = { createOaContactsWebhookHandler };
