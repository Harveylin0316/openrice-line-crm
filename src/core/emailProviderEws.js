const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function splitNtlmUser(value, fallbackDomain = '') {
  const raw = String(value || '').trim();
  const slash = raw.indexOf('\\');
  if (slash < 0) return { domain: String(fallbackDomain || '').trim(), username: raw };
  return { domain: raw.slice(0, slash).trim(), username: raw.slice(slash + 1).trim() };
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function runPythonWorker(action, payload, providerEnv) {
  const script = path.join(__dirname, '..', '..', 'scripts', 'revisit-ews-worker.py');
  return new Promise((resolve) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [script, action], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        LANG: process.env.LANG || 'en_US.UTF-8',
        ...providerEnv
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 20000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err && err.message || 'ews_worker_failed').slice(0, 500) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'ews_invalid_worker_response' });
      } catch (_err) {
        resolve({ ok: false, error: String(stderr || `ews_worker_exit_${code}`).slice(0, 500) });
      }
    });
    child.stdin.end(JSON.stringify(payload || {}));
  });
}

function createEwsEmailProvider(options = {}) {
  const env = options.env || process.env;
  const endpoint = String(env.REVISIT_EMAIL_EWS_URL || '').trim();
  const envFile = String(env.REVISIT_EMAIL_EWS_ENV_FILE || '').trim();
  const rawUser = String(env.REVISIT_EMAIL_EWS_USER || env.OUTREACH_EWS_USER || '').trim();
  const password = String(env.REVISIT_EMAIL_EWS_PASSWORD || env.OUTREACH_EWS_PASSWORD || '');
  const senderEmail = String(env.REVISIT_EMAIL_EWS_FROM_EMAIL || env.REVISIT_EMAIL_EWS_SEND_AS || env.OUTREACH_SEND_AS || '').trim();
  const senderName = String(env.REVISIT_EMAIL_EWS_FROM_NAME || env.SMTP_FROM_NAME || 'OpenRice 台灣開飯喇').trim();
  const replyTo = String(env.REVISIT_EMAIL_EWS_REPLY_TO || env.OUTREACH_REPLY_TO || senderEmail).trim();
  const worker = options.worker || runPythonWorker;
  const providerEnv = {
    REVISIT_EMAIL_EWS_URL: endpoint,
    REVISIT_EMAIL_EWS_ENV_FILE: envFile,
    REVISIT_EMAIL_EWS_USER: rawUser,
    REVISIT_EMAIL_EWS_PASSWORD: password,
    REVISIT_EMAIL_EWS_FROM_EMAIL: senderEmail,
    REVISIT_EMAIL_EWS_REPLY_TO: replyTo
  };

  function isConfigured() {
    return Boolean(/^https:\/\//i.test(endpoint) && ((rawUser && password) || (envFile && fs.existsSync(envFile))));
  }

  async function verify() {
    if (!isConfigured()) return { ok: false, error: 'ews_not_configured' };
    return worker('verify', {}, providerEnv);
  }

  async function sendEmail(mail = {}) {
    if (!isConfigured()) return { ok: false, error: 'ews_not_configured' };
    const payload = {
      to: String(mail.to || '').trim(),
      toName: String(mail.toName || '').trim(),
      subject: String(mail.subject || '').trim(),
      html: String(mail.html || ''),
      text: String(mail.text || ''),
      senderEmail: String(mail.senderEmail || senderEmail).trim(),
      senderName: String(mail.senderName || senderName).trim(),
      replyTo: String(mail.replyTo || replyTo).trim()
    };
    if (!payload.to || !payload.subject || !payload.html) return { ok: false, error: 'missing_required_fields' };
    return worker('send', payload, providerEnv);
  }

  return {
    isConfigured,
    verify,
    sendEmail,
    close: async () => {},
    getDefaultSender: () => ({ email: senderEmail || 'Exchange 預設信箱', name: senderName }),
    getProviderName: () => 'ews'
  };
}

module.exports = { createEwsEmailProvider, splitNtlmUser, xmlEscape, runPythonWorker };
