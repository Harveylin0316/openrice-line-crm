'use strict';

// Configuration is an explicit integration contract: the endpoint must have the
// companion script installed before enabling direct links for this LIFF app.
function configuredApps(env = process.env) {
  try {
    const raw = JSON.parse(env.BROADCAST_DIRECT_LIFF_APPS || '{}');
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') return {};
    const entries = [];
    for (const [id, endpoint] of Object.entries(raw)) {
      if (!/^\d+-[A-Za-z0-9]+$/.test(id) || typeof endpoint !== 'string') continue;
      try {
        const u = new URL(endpoint);
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) continue;
        entries.push([id, { endpoint: u.href, origin: u.origin, pathname: u.pathname }]);
      } catch (_) { /* An invalid entry never widens the allowlist. */ }
    }
    return Object.fromEntries(entries);
  } catch (_) { return {}; }
}

function appForTarget(uri, apps = configuredApps()) {
  try {
    const u = new URL(uri);
    if (u.origin !== 'https://liff.line.me' || u.username || u.password) return null;
    const m = /^\/(\d+-[A-Za-z0-9]+)\/?$/.exec(u.pathname);
    if (!m || !Object.hasOwn(apps, m[1]) || u.searchParams.has('or_bc') || u.searchParams.has('or_ex')) return null;
    return { id: m[1], ...apps[m[1]] };
  } catch (_) { return null; }
}

function parseReference(value) {
  if (typeof value !== 'string' || value.length > 90) return null;
  const m = /^([1-9]\d*)\.([1-9]\d*)\.(0|[1-9]\d*)\.([abc-])$/.exec(value);
  if (!m || !m.slice(1, 4).every(n => Number.isSafeInteger(Number(n)))) return null;
  return { broadcastId: Number(m[1]), recipientId: Number(m[2]), buttonIndex: Number(m[3]), variant: m[4] === '-' ? null : m[4] };
}

// 自動化／關鍵字／歡迎訊息（crm_message_executions）用：<32 碼執行代碼>.<連結序號>
function parseExecutionReference(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = /^([A-Za-z0-9_-]{32})\.(0|[1-9]\d{0,3})$/.exec(value);
  return m ? { code: m[1], index: Number(m[2]) } : null;
}

// Append without re-encoding campaign parameters or changing the fragment.
function appendParam(uri, name, ref) {
  const hashAt = uri.indexOf('#');
  const head = hashAt < 0 ? uri : uri.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : uri.slice(hashAt);
  return `${head}${head.includes('?') ? '&' : '?'}${name}=${ref}${hash}`;
}

function buildDirectLiffUrl(uri, { broadcastId, recipientId, buttonIndex, variant } = {}, env = process.env) {
  if (env.BROADCAST_DIRECT_LIFF_ENABLED !== '1' || !appForTarget(uri, configuredApps(env))) return null;
  const ref = `${broadcastId}.${recipientId}.${buttonIndex}.${variant == null ? '-' : variant}`;
  if (!parseReference(ref)) return null;
  return appendParam(uri, 'or_bc', ref);
}

// 同一個開關與活動清單：連到已安裝追蹤程式的 LIFF 時，直接開 LIFF（不經 /t/e 中轉頁），
// 避免活動頁 liff.closeWindow() 後留下外層空白視窗。
function buildDirectLiffExecutionUrl(uri, { code, index } = {}, env = process.env) {
  if (env.BROADCAST_DIRECT_LIFF_ENABLED !== '1' || !appForTarget(uri, configuredApps(env))) return null;
  const ref = `${code}.${index}`;
  if (!parseExecutionReference(ref)) return null;
  return appendParam(uri, 'or_ex', ref);
}

module.exports = { configuredApps, appForTarget, parseReference, parseExecutionReference, buildDirectLiffUrl, buildDirectLiffExecutionUrl };
