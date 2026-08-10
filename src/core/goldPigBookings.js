const crypto = require('crypto');

const ACTIVE_STATUSES = ['confirmed', 'cancellation_requested'];

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

  async function requestCancellation(lineUserId, requestedBookingNo) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const params = [lineUserId];
      let filter = '';
      if (requestedBookingNo) {
        params.push(requestedBookingNo);
        filter = ' AND booking_no = $2';
      }
      const result = await client.query(
        `SELECT id, booking_no, status, session_date, session_time, tables_4, tables_6, total_amount
         FROM gold_pig_bookings
         WHERE line_user_id = $1
           AND status = ANY($${requestedBookingNo ? '3' : '2'}::text[])
           ${filter}
         ORDER BY session_date ASC, session_time ASC
         FOR UPDATE`,
        requestedBookingNo ? [...params, ACTIVE_STATUSES] : [...params, ACTIVE_STATUSES]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      if (!requestedBookingNo && result.rowCount > 1) {
        await client.query('ROLLBACK');
        return { kind: 'choose', bookings: result.rows };
      }

      const booking = result.rows[0];
      if (booking.status === 'cancellation_requested') {
        await client.query('COMMIT');
        return { kind: 'already_requested', booking };
      }
      await client.query(
        `INSERT INTO gold_pig_cancellation_requests (booking_id, line_user_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (booking_id) WHERE status = 'pending' DO NOTHING`,
        [booking.id, lineUserId]
      );
      await client.query(
        `UPDATE gold_pig_bookings
         SET status = 'cancellation_requested', updated_at = now()
         WHERE id = $1`,
        [booking.id]
      );
      await client.query('COMMIT');
      return { kind: 'requested', booking: { ...booking, status: 'cancellation_requested' } };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
        messages: [`你的金豬食堂訂位\n\n${bookings.map(formatBooking).join('\n\n────────\n\n')}\n\n需要提出取消申請，請輸入「取消訂位」。`]
      };
    }

    const cancelMatch = /^取消訂位(?:\s+([A-Za-z0-9-]{6,32}))?$/.exec(text);
    if (!cancelMatch) return null;
    const bookingNo = cancelMatch[1] ? normalizeBookingNo(cancelMatch[1]) : '';
    const outcome = await requestCancellation(lineUserId, bookingNo);
    if (outcome.kind === 'choose') {
      const numbers = outcome.bookings.map(row => `・${row.booking_no}｜${formatDateValue(row.session_date)}`).join('\n');
      return {
        result: 'gold_pig_cancel_choose',
        messages: [`你有多筆有效訂位，請指定訂位編號：\n\n${numbers}\n\n例如：取消訂位 GP12345678`]
      };
    }
    if (outcome.kind === 'not_found') {
      return {
        result: 'gold_pig_cancel_not_found',
        messages: [bookingNo
          ? `找不到訂位編號 ${bookingNo}，或該訂位目前無法提出取消申請。請輸入「查詢訂位」確認。`
          : '目前沒有可提出取消申請的金豬食堂訂位。請輸入「查詢訂位」確認。']
      };
    }
    if (outcome.kind === 'already_requested') {
      return {
        result: 'gold_pig_cancel_already_requested',
        messages: [`訂位 ${outcome.booking.booking_no} 已提出取消申請，目前正在處理中。\n\n這不代表訂位已取消或退款完成；結果會由 OpenRice LINE 通知。`]
      };
    }
    return {
      result: 'gold_pig_cancel_requested',
      messages: [`已收到訂位 ${outcome.booking.booking_no} 的取消申請。\n\n重要：目前仍是「申請處理中」，不代表訂位已取消或退款完成。OpenRice 將依活動規則審核，結果會由 LINE 通知。`]
    };
  }

  return { handleCommand, listBookings };
}

module.exports = {
  ACTIVE_STATUSES,
  createGoldPigBookingService,
  formatDateValue,
  formatBooking,
  generateBookingToken,
  hashBookingToken,
  normalizeBookingNo
};
