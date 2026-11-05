'use strict';
const { Pool } = require('pg');
const { createClaim } = require('./lineWebhookInbox');

function createRuntime({ env = process.env, PoolClass = Pool, fetcher = (...args) => fetch(...args), worker = false } = {}) {
  let pool;
  function getPool() {
    if (!pool) {
      if (!env.DATABASE_URL) throw Error('missing_database');
      // The HTTP fallback must stay fast. Accepted background work has time to
      // tolerate a normal cross-region connection rather than failing at 500ms.
      pool = new PoolClass({ connectionString:env.DATABASE_URL,
        ssl:env.PG_SSL_DISABLED === '1' ? false : {rejectUnauthorized:false}, max:1,
        connectionTimeoutMillis:worker ? 3000 : 500,
        query_timeout:worker ? 6000 : 650,
        statement_timeout:worker ? 5000 : 600,
        idleTimeoutMillis:10000 });
      pool.on('error', () => console.error('line inbox idle connection error'));
    }
    return pool;
  }
  const query = (sql, params) => getPool().query(sql, params);
  const claim = createClaim({query});
  async function wake(timeoutMs = 300) {
    // Preview/staging must never wake production through Netlify's global URL.
    const isolated = env.APP_ENV === 'staging' || env.SAFE_PREVIEW_MODE === '1';
    const base = isolated ? (env.DEPLOY_URL || env.DEPLOY_PRIME_URL) : env.URL;
    const secret = env.SCHEDULED_RUNNER_SECRET;
    if (!base || !secret) throw Error('missing_worker_config');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetcher(new URL('/.netlify/functions/line-webhook-worker-background',base), {
        method:'POST',redirect:'error',headers:{'x-scheduler-secret':secret},signal:controller.signal });
      if (r.status !== 202) throw Error('worker_not_accepted');
    } finally { clearTimeout(timer); }
  }
  return { query, claim, wake };
}
module.exports = { ...createRuntime(), createRuntime };
