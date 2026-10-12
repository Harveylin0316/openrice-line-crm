'use strict';
const { Pool } = require('pg');
let pool;
function query(sql, params) {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw Error('missing_database');
    pool = new Pool({ connectionString:process.env.DATABASE_URL, ssl:process.env.PG_SSL_DISABLED === '1' ? false : {rejectUnauthorized:false}, max:1, connectionTimeoutMillis:500, query_timeout:650, statement_timeout:600, idleTimeoutMillis:10000 });
    pool.on('error', () => console.error('line inbox idle connection error'));
  }
  return pool.query(sql,params);
}
async function wake(timeoutMs = 300) {
  const base = process.env.URL, secret = process.env.SCHEDULED_RUNNER_SECRET;
  if (!base || !secret) throw Error('missing_worker_config');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(new URL('/.netlify/functions/line-webhook-worker-background',base), { method:'POST',headers:{'x-scheduler-secret':secret},signal:controller.signal });
    if (r.status !== 202) throw Error('worker_not_accepted');
  } finally { clearTimeout(timer); }
}
module.exports = { query, wake };
