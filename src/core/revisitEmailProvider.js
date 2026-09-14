const { createSmtpEmailProvider } = require('./emailProviderSmtp');
const { createEwsEmailProvider } = require('./emailProviderEws');

function createRevisitEmailProvider(options = {}) {
  const env = options.env || process.env;
  const ews = options.ewsProvider || createEwsEmailProvider({ env });
  const smtp = options.smtpProvider || createSmtpEmailProvider();
  const requested = String(env.REVISIT_EMAIL_PROVIDER || '').trim().toLowerCase();
  if (requested === 'ews') return ews;
  if (requested === 'smtp') return smtp;
  return ews.isConfigured() ? ews : smtp;
}

module.exports = { createRevisitEmailProvider };
