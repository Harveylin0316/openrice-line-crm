/**
 * Legacy：用 LINE Messaging API 的「取得個人檔案」檢查可聯絡性。
 *   GET https://api.line.me/v2/bot/profile/{userId}
 *     200 → 可取得個人檔案（不保證是好友）
 *     404 → 不是好友 / 已封鎖
 * Legacy 可聯絡性檢查，不是嚴格好友證明：未加好友但曾傳訊息者也可能回 200。
 * 通用遊戲及邀請獎勵必須改用 verifyGameOaFollower。
 *
 * Legacy 回傳：true = 可取得 profile；false = profile 404；null = 無法判定。
 * 僅保留既有非通用遊戲路由相容性，不得用於邀請／通用遊戲的獎勵資格。
 */
async function verifyOaFollower(lineUserId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const uid = String(lineUserId || '').trim();
  if (!uid) return false;
  if (!token) return null; // 未設 token → 交由呼叫端決定（預設放行）
  try {
    const resp = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(uid), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (resp.status === 200) return true;
    if (resp.status === 404) return false; // 不是好友（含偽造的假 userId）
    return null; // 其他狀態（429/5xx 等）視為無法判定
  } catch (e) {
    console.error('verifyOaFollower error:', e && e.message);
    return null;
  }
}

/**
 * 嚴格遊戲好友驗證：access token 必須同時屬於預期 Login channel、同一個用戶，
 * 並由 LINE friendship API 回 friendFlag。不能相信前端 friendFlag 或 bot profile 200。
 * 三個官方唯讀請求並行、各限 2 秒；驗證不可用回 null，呼叫端不得發獎。
 * 不記錄 access token，也不把 token 送進本地 URL／log／資料庫。
 */
async function verifyGameOaFollower(lineUserId, { accessToken, channelId } = {}) {
  const uid = String(lineUserId || '').trim();
  const token = String(accessToken || '').trim();
  const channel = String(channelId || '').trim();
  if (!/^U[0-9a-f]{32}$/i.test(uid) || !token || !channel) return null;
  const headers = { Authorization: 'Bearer ' + token };
  try {
    const get = async (url, options) => {
      const r = await fetch(url, { ...options, signal: AbortSignal.timeout(2000) });
      if (r.status !== 200) return null;
      return r.json();
    };
    const [verified, profile, friendship] = await Promise.all([
      get('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token)),
      get('https://api.line.me/v2/profile', { headers }),
      get('https://api.line.me/friendship/v1/status', { headers })
    ]);
    if (!verified || String(verified.client_id) !== channel || !(Number(verified.expires_in) > 0) ||
        !profile || profile.userId !== uid || !friendship || typeof friendship.friendFlag !== 'boolean') return null;
    return friendship.friendFlag;
  } catch (_e) {
    // fetch 錯誤可能包含請求 URL（含 token），不可直接記錄例外內容。
    return null;
  }
}

/**
 * 抓取某 userId 的 LINE 個人檔案（暱稱 + 大頭貼）。
 *   GET https://api.line.me/v2/bot/profile/{userId}
 * 回傳 { displayName, pictureUrl, statusMessage } ；無法取得（沒 token / 非好友 / API 錯誤）回 null。
 * 用途：新好友加入 OA 時把暱稱、大頭貼寫進 users 表（follow webhook 與回補腳本共用）。
 */
async function fetchOaProfile(lineUserId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const uid = String(lineUserId || '').trim();
  if (!token || !uid) return null;
  try {
    const resp = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(uid), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) return null;
    const j = await resp.json().catch(() => null);
    if (!j) return null;
    return {
      displayName: j.displayName || null,
      pictureUrl: j.pictureUrl || null,
      statusMessage: j.statusMessage || null
    };
  } catch (e) {
    console.error('fetchOaProfile error:', e && e.message);
    return null;
  }
}

module.exports = { verifyOaFollower, verifyGameOaFollower, fetchOaProfile };
