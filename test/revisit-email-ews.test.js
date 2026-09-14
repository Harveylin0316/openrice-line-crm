const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEwsEmailProvider, splitNtlmUser, xmlEscape } = require('../src/core/emailProviderEws');
const { createRevisitEmailProvider } = require('../src/core/revisitEmailProvider');

function configuredEnv(overrides = {}) {
  return {
    REVISIT_EMAIL_EWS_URL: 'https://exchange.example.com/EWS/Exchange.asmx',
    REVISIT_EMAIL_EWS_USER: 'DOMAIN\\mailer',
    REVISIT_EMAIL_EWS_PASSWORD: 'not-a-real-password',
    REVISIT_EMAIL_EWS_FROM_EMAIL: 'sales@example.com',
    REVISIT_EMAIL_EWS_FROM_NAME: 'Example Sender',
    REVISIT_EMAIL_EWS_REPLY_TO: 'reply@example.com',
    ...overrides
  };
}

test('EWS NTLM 帳號與 XML 內容輔助函式安全處理輸入', () => {
  assert.deepEqual(splitNtlmUser('DOMAIN\\mailer'), { domain: 'DOMAIN', username: 'mailer' });
  assert.equal(xmlEscape('<Hen & "朋友">'), '&lt;Hen &amp; &quot;朋友&quot;&gt;');
});

test('EWS 驗證與寄送只把必要設定交給本機 worker', async () => {
  const calls = [];
  const provider = createEwsEmailProvider({
    env: configuredEnv(),
    async worker(action, payload, workerEnv) {
      calls.push({ action, payload, workerEnv });
      return { ok: true, messageId: '', response: 'NoError' };
    }
  });
  assert.equal(provider.isConfigured(), true);
  assert.equal(provider.getProviderName(), 'ews');
  assert.deepEqual(provider.getDefaultSender(), { email: 'sales@example.com', name: 'Example Sender' });
  assert.equal((await provider.verify()).ok, true);
  assert.equal((await provider.sendEmail({
    to: 'hen@example.com', toName: 'Hen', subject: '歡迎回來', html: '<p>查看優惠</p>'
  })).ok, true);
  assert.equal(calls[0].action, 'verify');
  assert.equal(calls[1].action, 'send');
  assert.equal(calls[1].payload.to, 'hen@example.com');
  assert.equal(calls[1].payload.replyTo, 'reply@example.com');
  assert.equal(calls[1].workerEnv.REVISIT_EMAIL_EWS_USER, 'DOMAIN\\mailer');
});

test('EWS 未設定時不啟動 worker，未指定 Send As 也可使用登入信箱', async () => {
  let called = false;
  const empty = createEwsEmailProvider({ env: {}, worker: async () => { called = true; } });
  assert.deepEqual(await empty.verify(), { ok: false, error: 'ews_not_configured' });
  assert.equal(called, false);
  const provider = createEwsEmailProvider({
    env: configuredEnv({ REVISIT_EMAIL_EWS_FROM_EMAIL: '', REVISIT_EMAIL_EWS_SEND_AS: '', OUTREACH_SEND_AS: '' }),
    async worker(_action, payload) {
      assert.equal(payload.senderEmail, '');
      return { ok: true };
    }
  });
  assert.equal(provider.isConfigured(), true);
  assert.equal((await provider.sendEmail({ to: 'hen@example.com', subject: '主旨', html: '<p>內容</p>' })).ok, true);
});

test('EWS 可引用既有本機 dotenv，不必把密碼複製進 CRM 設定', () => {
  const provider = createEwsEmailProvider({
    env: {
      REVISIT_EMAIL_EWS_URL: 'https://exchange.example.com/EWS/Exchange.asmx',
      REVISIT_EMAIL_EWS_ENV_FILE: path.join(__dirname, 'revisit-email-ews.test.js')
    }
  });
  assert.equal(provider.isConfigured(), true);
});

test('回訪寄件器可明確選 EWS，未指定時優先使用已設定的 EWS', () => {
  const ews = { isConfigured: () => true, getProviderName: () => 'ews' };
  const smtp = { isConfigured: () => true, getProviderName: () => 'smtp' };
  assert.equal(createRevisitEmailProvider({ env: { REVISIT_EMAIL_PROVIDER: 'smtp' }, ewsProvider: ews, smtpProvider: smtp }), smtp);
  assert.equal(createRevisitEmailProvider({ env: { REVISIT_EMAIL_PROVIDER: 'ews' }, ewsProvider: ews, smtpProvider: smtp }), ews);
  assert.equal(createRevisitEmailProvider({ env: {}, ewsProvider: ews, smtpProvider: smtp }), ews);
});
