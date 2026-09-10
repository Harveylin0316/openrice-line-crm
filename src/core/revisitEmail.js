const crypto = require('crypto');

const BOOKING_ALIASES = {
  externalBookingId: ['external_booking_id', 'booking_id', 'booking_no', 'booking_number', 'reservation_id', '訂位編號'],
  restaurantId: ['restaurant_id', 'poi_id', 'restaurantid', 'merchant_id', '店家id', '餐廳id', '餐廳編號'],
  restaurantName: ['restaurant_name', 'restaurant', 'merchant_name', '店名', '餐廳名稱'],
  customerEmail: ['customer_email', 'guest_email', 'member_email', 'email', '電子郵件', '客戶email', '顧客email'],
  customerName: ['customer_name', 'guest_name', 'member_name', 'name', '姓名', '客戶姓名', '顧客姓名'],
  diningDate: ['dining_date', 'visit_date', 'booking_date', 'session_date', '用餐日期', '到店日期', '訂位日期'],
  bookingStatus: ['booking_status', 'reservation_status', 'status', '訂位狀態', '狀態'],
  marketingConsent: ['marketing_consent', 'email_consent', 'consent', '行銷同意', '同意行銷'],
  bookingUrl: ['booking_url', 'restaurant_url', 'cta_url', 'booking_link', '訂位連結', '餐廳連結']
};

const OFFER_ALIASES = {
  externalOfferId: ['external_offer_id', 'offer_id', 'discount_offer_id', '優惠編號', '套餐編號'],
  restaurantId: BOOKING_ALIASES.restaurantId,
  restaurantName: BOOKING_ALIASES.restaurantName,
  offerType: ['offer_type', 'type', '優惠類型', '類型'],
  title: ['offer_title', 'title', 'offer_name', 'discount_name', '優惠名稱', '套餐名稱', '標題'],
  description: ['offer_description', 'description', 'details', '優惠內容', '套餐內容', '說明'],
  discountLabel: ['discount_label', 'discount', '折扣', '優惠標示'],
  priceLabel: ['price_label', 'price', '價格', '套餐價格'],
  validFrom: ['valid_from', 'start_date', '開始日期', '生效日期'],
  validUntil: ['valid_until', 'end_date', '結束日期', '到期日期', '有效期限'],
  ctaUrl: ['cta_url', 'url', 'booking_url', 'offer_url', '連結', '訂位連結'],
  terms: ['terms', 'terms_and_conditions', '注意事項', '使用條款'],
  isActive: ['is_active', 'active', 'status', '啟用', '有效']
};

function canonicalKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_\-./\\()[\]（）]+/g, '');
}

function readAlias(row, aliases) {
  const indexed = new Map();
  Object.keys(row || {}).forEach((key) => indexed.set(canonicalKey(key), row[key]));
  for (const alias of aliases) {
    const key = canonicalKey(alias);
    if (indexed.has(key)) return indexed.get(key);
  }
  return undefined;
}

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}

function parseDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const serial = Number(value);
    if (Number.isFinite(serial) && serial >= 20000 && serial <= 100000) {
      const epoch = Date.UTC(1899, 11, 30);
      return new Date(epoch + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
    }
  }
  const raw = String(value).trim();
  const ymd = raw.match(/^(\d{4})[\-/年.](\d{1,2})[\-/月.](\d{1,2})/);
  if (ymd) {
    const result = `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
    const d = new Date(result + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== result ? '' : result;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function parseBoolean(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const key = canonicalKey(value);
  if (['1', 'true', 'yes', 'y', '是', '有', '同意', 'active', 'enabled', '啟用'].includes(key)) return true;
  if (['0', 'false', 'no', 'n', '否', '無', '不同意', 'inactive', 'disabled', '停用'].includes(key)) return false;
  return fallback;
}

function normalizeBookingStatus(value) {
  const key = canonicalKey(value);
  if (['completed', 'complete', 'attended', 'seated', 'done', 'visited', 'show', 'fulfilled', '已完成', '已到店', '已入座', '完成'].includes(key)) return 'completed';
  if (['cancelled', 'canceled', 'cancel', '已取消', '取消'].includes(key)) return 'cancelled';
  if (['noshow', 'no-show', '未到店', '未出席', '爽約'].includes(key)) return 'no_show';
  return 'unknown';
}

function normalizeOfferType(value) {
  const key = canonicalKey(value);
  if (['setmenu', 'menu', 'package', '套餐', '套票'].includes(key)) return 'set_menu';
  if (['discount', 'offer', 'deal', '折扣', '優惠'].includes(key)) return 'discount';
  return 'other';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeBookingRecord(row, options = {}) {
  const externalBookingId = clip(readAlias(row, BOOKING_ALIASES.externalBookingId), 160);
  const restaurantId = clip(readAlias(row, BOOKING_ALIASES.restaurantId), 160);
  const restaurantName = clip(readAlias(row, BOOKING_ALIASES.restaurantName), 200);
  const customerEmail = clip(readAlias(row, BOOKING_ALIASES.customerEmail), 320).toLowerCase();
  const customerName = clip(readAlias(row, BOOKING_ALIASES.customerName), 120) || null;
  const diningDate = parseDate(readAlias(row, BOOKING_ALIASES.diningDate));
  const rawStatus = readAlias(row, BOOKING_ALIASES.bookingStatus);
  const bookingStatus = normalizeBookingStatus(rawStatus);
  const rawConsent = readAlias(row, BOOKING_ALIASES.marketingConsent);
  // A file-level confirmation may fill a blank consent column, but an unknown
  // non-empty value must never be interpreted as consent.
  const hasConsentValue = rawConsent != null && String(rawConsent).trim() !== '';
  const marketingConsent = hasConsentValue
    ? parseBoolean(rawConsent, false)
    : options.confirmedMarketing === true;
  const rawUrl = clip(readAlias(row, BOOKING_ALIASES.bookingUrl), 1200);
  const bookingUrl = isHttpUrl(rawUrl) ? rawUrl : null;
  const errors = [];
  if (!externalBookingId) errors.push('缺少訂位編號');
  if (!restaurantId) errors.push('缺少餐廳 ID');
  if (!restaurantName) errors.push('缺少餐廳名稱');
  if (!isValidEmail(customerEmail)) errors.push('Email 格式錯誤');
  if (!diningDate) errors.push('用餐日期格式錯誤');
  if (bookingStatus === 'unknown') errors.push(`無法辨識訂位狀態：${clip(rawStatus, 40) || '空白'}`);
  return {
    ok: errors.length === 0,
    errors,
    value: {
      externalBookingId, restaurantId, restaurantName, customerEmail, customerName,
      diningDate, bookingStatus, marketingConsent, bookingUrl
    }
  };
}

function stableOfferId(value) {
  return 'generated-' + crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizeOfferRecord(row) {
  const restaurantId = clip(readAlias(row, OFFER_ALIASES.restaurantId), 160);
  const restaurantName = clip(readAlias(row, OFFER_ALIASES.restaurantName), 200);
  const offerType = normalizeOfferType(readAlias(row, OFFER_ALIASES.offerType));
  const title = clip(readAlias(row, OFFER_ALIASES.title), 240);
  const description = clip(readAlias(row, OFFER_ALIASES.description), 2000) || null;
  const discountLabel = clip(readAlias(row, OFFER_ALIASES.discountLabel), 120) || null;
  const priceLabel = clip(readAlias(row, OFFER_ALIASES.priceLabel), 120) || null;
  const validFrom = parseDate(readAlias(row, OFFER_ALIASES.validFrom));
  const validUntil = parseDate(readAlias(row, OFFER_ALIASES.validUntil));
  const ctaUrl = clip(readAlias(row, OFFER_ALIASES.ctaUrl), 1200);
  const terms = clip(readAlias(row, OFFER_ALIASES.terms), 2000) || null;
  const isActive = parseBoolean(readAlias(row, OFFER_ALIASES.isActive), true);
  let externalOfferId = clip(readAlias(row, OFFER_ALIASES.externalOfferId), 160);
  if (!externalOfferId && restaurantId && title && validUntil) {
    externalOfferId = stableOfferId([restaurantId, title, validFrom, validUntil].join('|'));
  }
  const errors = [];
  if (!restaurantId) errors.push('缺少餐廳 ID');
  if (!restaurantName) errors.push('缺少餐廳名稱');
  if (!title) errors.push('缺少優惠／套餐名稱');
  if (!validFrom || !validUntil) errors.push('優惠日期格式錯誤');
  if (validFrom && validUntil && validUntil < validFrom) errors.push('優惠結束日早於開始日');
  if (!isHttpUrl(ctaUrl)) errors.push('CTA 連結格式錯誤');
  return {
    ok: errors.length === 0,
    errors,
    value: {
      externalOfferId, restaurantId, restaurantName, offerType, title, description,
      discountLabel, priceLabel, validFrom, validUntil, ctaUrl, terms, isActive
    }
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(dateValue) {
  const iso = parseDate(dateValue);
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function renderRevisitHtml(input) {
  const subject = clip(input.subject, 200);
  const preheader = clip(input.preheader, 300);
  const restaurantName = clip(input.restaurantName, 200);
  const recipientName = clip(input.recipientName, 120);
  const bodyText = clip(input.bodyText, 4000);
  const ctaUrl = isHttpUrl(input.ctaUrl) ? input.ctaUrl : '';
  const ctaLabel = clip(input.ctaLabel || '查看餐廳並訂位', 60);
  const offer = input.offer && typeof input.offer === 'object' ? input.offer : null;
  const unsubscribeUrl = isHttpUrl(input.unsubscribeUrl) ? input.unsubscribeUrl : '';
  const openPixelUrl = isHttpUrl(input.openPixelUrl) ? input.openPixelUrl : '';
  const greeting = recipientName ? `${recipientName}，你好` : '你好';
  const bodyParagraphs = bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.8;color:#4E3C2D;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const offerMeta = offer
    ? [offer.discountLabel, offer.priceLabel, offer.validUntil ? `活動至 ${formatDate(offer.validUntil)}` : ''].filter(Boolean).join('・')
    : '';
  const offerBlock = offer ? `
    <tr><td style="padding:8px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF8DD;border:1px solid #F9C73B;border-radius:14px;">
        <tr><td style="padding:20px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
          <div style="font-size:12px;font-weight:700;color:#E64A19;letter-spacing:.06em;">${offer.offerType === 'set_menu' ? '本店套餐' : '本店優惠'}</div>
          <div style="margin-top:6px;font-size:20px;line-height:1.45;font-weight:800;color:#3E2C23;">${escapeHtml(offer.title || '')}</div>
          ${offer.description ? `<div style="margin-top:8px;font-size:14px;line-height:1.7;color:#6D5A4B;">${escapeHtml(offer.description).replace(/\n/g, '<br>')}</div>` : ''}
          ${offerMeta ? `<div style="margin-top:10px;font-size:13px;font-weight:700;color:#8A5B00;">${escapeHtml(offerMeta)}</div>` : ''}
          ${offer.terms ? `<div style="margin-top:10px;font-size:11px;line-height:1.6;color:#8C7A6B;">${escapeHtml(offer.terms).replace(/\n/g, '<br>')}</div>` : ''}
        </td></tr>
      </table>
    </td></tr>` : '';
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F3EF;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:18px;overflow:hidden;">
    <tr><td style="height:8px;background:#F9C73B;"></td></tr>
    <tr><td style="padding:28px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
      <div style="font-size:15px;font-weight:800;color:#E64A19;">OpenRice 台灣開飯喇</div>
      <h1 style="margin:12px 0 0;font-size:28px;line-height:1.35;color:#3E2C23;">${escapeHtml(restaurantName)}</h1>
    </td></tr>
    <tr><td style="padding:14px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
      <p style="margin:0 0 16px;font-size:16px;line-height:1.8;color:#4E3C2D;">${escapeHtml(greeting)}</p>${bodyParagraphs}
    </td></tr>
    ${offerBlock}
    <tr><td align="center" style="padding:28px 32px 34px;">
      <a href="${escapeHtml(ctaUrl)}" target="_blank" style="display:block;padding:16px 24px;border-radius:12px;background:#F9C73B;color:#3E2C23;text-decoration:none;font:800 17px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">${escapeHtml(ctaLabel)}</a>
    </td></tr>
  </table>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;"><tr><td align="center" style="padding:20px 24px;font:12px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;color:#8C7A6B;">
    你收到這封信，是因為曾透過 OpenRice 完成餐廳訂位。<br>${unsubscribeUrl ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6D5A4B;text-decoration:underline;">不再接收回訪 Email</a>` : ''}
  </td></tr></table>
</td></tr></table>${openPixelUrl ? `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : ''}</body></html>`;
}

function renderRevisitText(input) {
  const greeting = clip(input.recipientName, 120) ? `${clip(input.recipientName, 120)}，你好` : '你好';
  const lines = [clip(input.subject, 200), '', greeting, '', clip(input.bodyText, 4000), ''];
  if (input.ctaLabel && isHttpUrl(input.ctaUrl)) lines.push(`${clip(input.ctaLabel, 60)}：${input.ctaUrl}`, '');
  if (isHttpUrl(input.unsubscribeUrl)) lines.push(`取消訂閱：${input.unsubscribeUrl}`);
  return lines.join('\n').trim();
}

function buildRevisitMessage(input) {
  const restaurantName = clip(input.restaurantName, 200);
  const offer = input.offer && typeof input.offer === 'object' ? input.offer : null;
  const offerCtaUrl = offer && (offer.cta_url || offer.ctaUrl);
  const baseCtaUrl = isHttpUrl(offerCtaUrl) ? offerCtaUrl : input.bookingUrl;
  const ctaUrl = input.clickUrl || baseCtaUrl;
  const normalizedOffer = offer ? {
    offerType: offer.offer_type || offer.offerType || 'other',
    title: offer.title,
    description: offer.description,
    discountLabel: offer.discount_label || offer.discountLabel,
    priceLabel: offer.price_label || offer.priceLabel,
    validUntil: offer.valid_until || offer.validUntil,
    terms: offer.terms
  } : null;
  let subject;
  let preheader;
  let bodyText;
  let ctaLabel = '查看餐廳並訂位';
  if (normalizedOffer && normalizedOffer.offerType === 'set_menu') {
    subject = `${restaurantName}｜${offer.title}`;
    preheader = `${offer.priceLabel ? offer.priceLabel + '，' : ''}套餐供應至 ${formatDate(offer.validUntil)}`;
    bodyText = `還記得上次在 ${restaurantName} 的那一餐嗎？\n\n最近店裡有「${offer.title}」，適合找熟悉的人再約一桌。${offer.description ? `\n${offer.description}` : ''}`;
    ctaLabel = '查看套餐並訂位';
  } else if (offer) {
    subject = `${restaurantName} 有新的回訪優惠，找一天再來吃吧`;
    preheader = `${offer.discountLabel || offer.title}，活動至 ${formatDate(offer.validUntil)}`;
    bodyText = `還記得上次在 ${restaurantName} 的那一餐嗎？\n\n最近店裡有「${offer.title}」，如果剛好想再回味，現在是個不錯的時機。${offer.description ? `\n${offer.description}` : ''}`;
    ctaLabel = '查看優惠並訂位';
  } else {
    subject = `好久不見，找一天再回 ${restaurantName} 吃飯吧`;
    preheader = `OpenRice 幫你快速查看 ${restaurantName} 的最新資訊與訂位時段`;
    bodyText = `還記得上次在 ${restaurantName} 的那一餐嗎？\n\n有時候不用特別找新地方，回到喜歡的餐廳，也是一個很好的聚餐理由。`;
  }
  const html = renderRevisitHtml({
    subject, preheader, restaurantName, recipientName: input.recipientName,
    bodyText, ctaUrl, ctaLabel, offer: normalizedOffer,
    unsubscribeUrl: input.unsubscribeUrl, openPixelUrl: input.openPixelUrl
  });
  const text = renderRevisitText({
    subject, recipientName: input.recipientName, bodyText, ctaLabel,
    ctaUrl: baseCtaUrl, unsubscribeUrl: input.unsubscribeUrl
  });
  return { subject, preheader, bodyText, ctaLabel, ctaUrl: baseCtaUrl, html, text };
}

module.exports = {
  BOOKING_ALIASES,
  OFFER_ALIASES,
  buildRevisitMessage,
  isHttpUrl,
  isValidEmail,
  normalizeBookingRecord,
  normalizeBookingStatus,
  normalizeOfferRecord,
  parseDate,
  renderRevisitHtml,
  renderRevisitText
};
