const nodemailer = require('nodemailer');

function createSmtpEmailProvider() {
  const host = String(process.env.SMTP_HOST || process.env.SMTP_SERVER || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const password = String(process.env.SMTP_PASSWORD || '');
  const senderEmail = String(process.env.SMTP_FROM_EMAIL || process.env.SMTP_FROM || user).trim();
  const senderName = String(process.env.SMTP_FROM_NAME || 'OpenRice 台灣開飯喇').trim();
  const replyTo = String(process.env.SMTP_REPLY_TO || senderEmail).trim();
  const secure = String(process.env.SMTP_SECURE || '').trim() === '1' || port === 465;
  let transporter = null;

  function isConfigured() {
    return Boolean(host && Number.isFinite(port) && port > 0 && user && password && senderEmail);
  }

  function getTransporter() {
    if (!isConfigured()) return null;
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: !secure,
        pool: true,
        maxConnections: 1,
        maxMessages: 100,
        auth: { user, pass: password },
        tls: { minVersion: 'TLSv1.2' },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 60000
      });
    }
    return transporter;
  }

  async function verify() {
    if (!isConfigured()) return { ok: false, error: 'smtp_not_configured' };
    try {
      await getTransporter().verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 500) };
    }
  }

  async function sendEmail(options = {}) {
    if (!isConfigured()) return { ok: false, error: 'smtp_not_configured' };
    const to = String(options.to || '').trim();
    const subject = String(options.subject || '').trim();
    const html = String(options.html || '');
    if (!to || !subject || !html) return { ok: false, error: 'missing_required_fields' };
    try {
      const info = await getTransporter().sendMail({
        from: {
          name: String(options.senderName || senderName).trim(),
          address: String(options.senderEmail || senderEmail).trim()
        },
        to: options.toName ? { name: String(options.toName), address: to } : to,
        replyTo: String(options.replyTo || replyTo).trim() || undefined,
        subject,
        html,
        text: options.text || undefined,
        headers: {
          'X-OpenRice-Message-Type': 'booking-revisit',
          ...(options.headers && typeof options.headers === 'object' ? options.headers : {})
        }
      });
      return {
        ok: true,
        messageId: info && info.messageId ? String(info.messageId) : '',
        response: info && info.response ? String(info.response).slice(0, 500) : ''
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 1500) };
    }
  }

  async function close() {
    if (transporter && typeof transporter.close === 'function') transporter.close();
    transporter = null;
  }

  return {
    isConfigured,
    verify,
    sendEmail,
    close,
    getDefaultSender: () => ({ email: senderEmail, name: senderName })
  };
}

module.exports = { createSmtpEmailProvider };
