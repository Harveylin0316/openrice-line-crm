const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the app's actual URL resolver without starting DB/provider services.
function resolver(env = {}, isSafePreview = true) {
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const code = source.slice(source.indexOf('function normalizeLinePushPublicBaseUrl('),
    source.indexOf('function normalizeAdminLoginPath('));
  const context = { URL, process: { env }, isSafePreview, isProduction: false,
    LINE_CHANNEL_ACCESS_TOKEN: '', buildPushImageBaseCandidates: () => [] };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.resolvePublicSiteOrigin;
}
const staging = 'https://staging--openrice-line-crm.netlify.app';
const production = 'https://openrice-line-crm.netlify.app';
const request = (headers, protocol = 'https') => ({ protocol, get: key => headers[key] });

test('Staging upload origin ignores inherited production URL settings', () => {
  const resolve = resolver({ URL: production, PUBLIC_SITE_URL: production,
    LINE_PUSH_PUBLIC_BASE_URL: production, DEPLOY_PRIME_URL: staging });
  assert.equal(resolve(request({ host: 'staging--openrice-line-crm.netlify.app' })), staging);
});

test('Staging behind a proxy uses the current forwarded host and protocol', () => {
  const resolve = resolver({ URL: production });
  assert.equal(resolve(request({ host: 'localhost', 'x-forwarded-host':
    'staging--openrice-line-crm.netlify.app, proxy.internal',
    'x-forwarded-proto': 'https, http' }, 'http')), staging);
});

test('Safe preview without a request does not fall back to production', () => {
  assert.equal(resolver({ URL: production })(undefined), '');
});

test('Production keeps its explicitly configured public origin', () => {
  assert.equal(resolver({ LINE_PUSH_PUBLIC_BASE_URL: production }, false)(
    request({ host: 'internal.example' })), production);
});

test('Local safe preview uses the local request origin', () => {
  assert.equal(resolver({ URL: production })(request({ host: 'localhost:3000' }, 'http')),
    'http://localhost:3000');
});
