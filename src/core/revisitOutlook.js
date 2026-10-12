'use strict';
const { isValidEmail, isHttpUrl, renderRevisitText } = require('./revisitEmail');
const DRAFT_REASON = 'outlook_draft_requested';
function buildOutlookDraft(row, origin) {
  const email = String(row.recipient_email || '').trim();
  const subject = String(row.subject || '').trim();
  if (!isValidEmail(email) || /[\r\n,;]/.test(email) || !subject || /[\r\n]/.test(subject)) throw Error('invalid_draft_content');
  if (!isHttpUrl(row.cta_url) || !/^https:\/\//.test(origin) || !/^[a-f0-9]{48}$/.test(row.unsubscribe_token || '')) throw Error('invalid_draft_links');
  const body = renderRevisitText({ subject, recipientName: row.recipient_name, bodyText: row.body_copy,
    ctaLabel: '查看餐廳並訂位', ctaUrl: row.cta_url,
    unsubscribeUrl: `${origin}/email/revisit/unsubscribe/${row.unsubscribe_token}` }).replace(/\r?\n/g, '\r\n');
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  // Some desktop mail handlers truncate long URIs. Never truncate the message:
  // the UI offers the complete recipient, subject and body for copying instead.
  return { email, subject, body, mailto: mailto.length <= 2000 ? mailto : null };
}
module.exports = { buildOutlookDraft, DRAFT_REASON };
