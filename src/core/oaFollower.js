/**
 * 用 LINE Messaging API 的「取得個人檔案」端點判斷某 userId 是不是本 OA 的好友。
 *   GET https://api.line.me/v2/bot/profile/{userId}
 *     200 → 是好友（follower）
 *     404 → 不是好友 / 已封鎖
 * 這是唯一可靠、且無法被前端偽造的「是否加 OA」判定（伺服器持 channel token 直接問 LINE）。
 *
 * 回傳：true = 確定是好友；false = 確定不是好友；null = 無法判定（沒 token / API 錯誤）
 * 呼叫端政策：只在「確定 false」時阻擋（擋假 id / 未加好友）；null 時放行（避免設定缺失或暫時性錯誤誤殺真用戶）。
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

module.exports = { verifyOaFollower, fetchOaProfile };
