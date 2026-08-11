/**
 * LIFF ID Token 驗證 — 向 LINE 驗證前端送來的 id token，取得「無法被偽造」的真實 userId。
 *   POST https://api.line.me/oauth2/v2.1/verify  (id_token, client_id=該 LIFF 的 Login channel id)
 *     200 → 回 { sub, aud, ... }，sub 即該用戶在此 channel 的 userId
 *     其他 → 驗證失敗（過期/偽造/client_id 不符）
 *
 * channelId = LIFF id 破折號前那段（例：2008944358-649rLhGj → 2008944358）。
 */
function channelIdFromLiffId(liffId) {
  const s = String(liffId || '').trim();
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次嘗試的逾時與重試間隔。Netlify function 預設 10 秒上限，
// 最壞情況 2+0.1+2+0.25+2 ≈ 6.4 秒，留得下 DB 的時間。
const ATTEMPT_TIMEOUT_MS = 2000;
const BACKOFF_MS = [100, 250];

/**
 * 驗證 id token。網路錯誤與 5xx 會重試（實測 Netlify → LINE 之間會偶發
 * "fetch failed"，落在 /play 就是使用者白按一次抽獎）；
 * 4xx 是確定性失敗（token 過期／偽造／client_id 不符），不重試。
 */
async function verifyLiffIdToken(idToken, channelId, opts) {
  const tok = String(idToken || '').trim();
  const cid = String(channelId || '').trim();
  if (!tok) return { ok: false, reason: 'no_token', attempts: 0 };
  if (!cid) return { ok: false, reason: 'no_channel_id', attempts: 0 };

  const maxAttempts = Math.max(1, (opts && opts.attempts) || 3);
  const body = new URLSearchParams();
  body.set('id_token', tok);
  body.set('client_id', cid);

  let last = { ok: false, reason: 'error', detail: 'no attempt' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      });
      if (resp.status === 200) {
        const data = await resp.json();
        return { ok: true, sub: data.sub || null, aud: data.aud || null, attempts: attempt };
      }
      const t = await resp.text().catch(() => '');
      last = { ok: false, reason: 'verify_failed', status: resp.status, detail: String(t).slice(0, 200), attempts: attempt };
      // 4xx = token 本身有問題，重試幾次都一樣
      if (resp.status < 500) return last;
    } catch (e) {
      last = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 200), attempts: attempt };
    }
    if (attempt < maxAttempts) await sleep(BACKOFF_MS[attempt - 1] || 250);
  }
  return last;
}

module.exports = { verifyLiffIdToken, channelIdFromLiffId };
