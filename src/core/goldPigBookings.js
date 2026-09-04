const crypto = require('crypto');

function hashBookingToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || ''), 'utf8').digest('hex');
}

function generateBookingToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeBookingNo(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9-]{6,32}$/.test(normalized) ? normalized : '';
}

function formatMoney(value) {
  return 'NT$' + Number(value || 0).toLocaleString('zh-TW');
}

function formatDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || '');
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  return match ? match[0] : text.slice(0, 10);
}

function formatBooking(row) {
  const date = formatDateValue(row.session_date);
  const time = String(row.session_time || '').slice(0, 5);
  const tables = [
    Number(row.tables_4 || 0) ? `4 人桌 × ${Number(row.tables_4)}` : '',
    Number(row.tables_6 || 0) ? `6 人桌 × ${Number(row.tables_6)}` : ''
  ].filter(Boolean).join('、');
  const status = row.status === 'cancellation_requested' ? '取消申請處理中' : '已付款・已成立';
  return [
    `訂位編號：${row.booking_no}`,
    `日期時間：${date} ${time}`,
    `桌型：${tables || '—'}`,
    `金額：${formatMoney(row.total_amount)}`,
    `狀態：${status}`
  ].join('\n');
}

function createGoldPigBookingService({ pool }) {
  async function listBookings(lineUserId) {
    const result = await pool.query(
      `SELECT booking_no, status, session_date, session_time, tables_4, tables_6, total_amount
       FROM gold_pig_bookings
       WHERE line_user_id = $1
       ORDER BY session_date ASC, session_time ASC, created_at DESC`,
      [lineUserId]
    );
    return result.rows;
  }

  async function handleCommand(lineUserId, messageText) {
    const text = String(messageText || '').trim();
    if (text === '查詢訂位' || text === '查看訂位') {
      const bookings = await listBookings(lineUserId);
      if (bookings.length === 0) {
        return {
          result: 'gold_pig_booking_none',
          messages: ['目前沒有綁定到這個 LINE 帳號的金豬食堂訂位。\n\n請從付款完成頁點「綁定這筆訂位」完成連結；若連結已失效，請聯絡客服。']
        };
      }
      return {
        result: 'gold_pig_booking_queried',
        messages: [`你的金豬食堂訂位\n\n${bookings.map(formatBooking).join('\n\n────────\n\n')}`]
      };
    }
    // 取消訂位不再是系統內建指令。留給後台「關鍵字回覆」或客服流程管理，
    // 避免一段藏在程式裡、後台找不到也關不掉的自動回覆。
    return null;
  }

  return { handleCommand, listBookings };
}

module.exports = {
  createGoldPigBookingService,
  formatDateValue,
  formatBooking,
  generateBookingToken,
  hashBookingToken,
  normalizeBookingNo
};
