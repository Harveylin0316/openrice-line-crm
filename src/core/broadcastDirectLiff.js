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
    if (!m || !Object.hasOwn(apps, m[1]) || u.searchParams.has('or_bc')) return null;
    return { id: m[1], ...apps[m[1]] };
  } catch (_) { return null; }
}

function parseReference(value) {
  if (typeof value !== 'string' || value.length > 90) return null;
  const m = /^([1-9]\d*)\.([1-9]\d*)\.(0|[1-9]\d*)\.([abc-])$/.exec(value);
  if (!m || !m.slice(1, 4).every(n => Number.isSafeInteger(Number(n)))) return null;
  return { broadcastId: Number(m[1]), recipientId: Number(m[2]), buttonIndex: Number(m[3]), variant: m[4] === '-' ? null : m[4] };
}

function buildDirectLiffUrl(uri, { broadcastId, recipientId, buttonIndex, variant } = {}, env = process.env) {
  if (env.BROADCAST_DIRECT_LIFF_ENABLED !== '1' || !appForTarget(uri, configuredApps(env))) return null;
  const ref = `${broadcastId}.${recipientId}.${buttonIndex}.${variant == null ? '-' : variant}`;
  if (!parseReference(ref)) return null;
  // Append without re-encoding campaign parameters or changing the fragment.
  const hashAt = uri.indexOf('#');
  const head = hashAt < 0 ? uri : uri.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : uri.slice(hashAt);
  return `${head}${head.includes('?') ? '&' : '?'}or_bc=${ref}${hash}`;
}

module.exports = { configuredApps, appForTarget, parseReference, buildDirectLiffUrl };
