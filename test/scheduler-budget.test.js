'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const serverless = require('serverless-http');
const { createDispatch } = require('../netlify/lib/schedulerDispatch');
const { createMinuteRunner } = require('../netlify/functions/scheduled-flow-runner');
const env = { URL: 'https://qa.invalid', SCHEDULED_RUNNER_SECRET: 'synthetic-scheduler-secret' };

test('dispatcher preserves POST body, origin and scheduler auth through real Express adapter without HTTP', async () => {
  const app = express(); app.use(express.json());
  let calls = 0;
  app.post('/admin/flows/run', (req, res) => {
    assert.equal(req.get('x-scheduler-secret'), env.SCHEDULED_RUNNER_SECRET);
    assert.equal(req.hostname, 'qa.invalid');
    assert.equal(req.body.source, 'netlify-scheduled-flows');
    calls++; res.status(207).json({ ok: true });
  });
  const run = createDispatch(() => serverless(app), env);
  const r = await run('/admin/flows/run', 'netlify-scheduled-flows');
  assert.equal(r.statusCode, 207); assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(calls, 1);
});

test('missing config and unapproved paths never load the application', async () => {
  const never = () => { throw Error('must not load'); };
  assert.equal((await createDispatch(never, {})('/admin/flows/run')).statusCode, 500);
  assert.match((await createDispatch(never, { URL: env.URL })('/admin/flows/run')).body, /skipped/);
  await assert.rejects(createDispatch(never, env)('/admin/broadcast/send'), /unsupported/);
});

test('retired standalone rescue endpoint rejects anonymous requests before DB access', async () => {
  const { handler } = require('../netlify/functions/scheduled-line-webhook-runner');
  assert.equal((await handler()).statusCode, 403);
  assert.equal((await handler({ headers: { 'x-scheduler-secret': 'wrong' } })).statusCode, 403);
});

test('dispatcher retains actual activity scheduler route auth and behavior', async () => {
  const { registerAdminActivitiesRoutes } = require('../src/routes/adminActivities');
  const before = process.env.SCHEDULED_RUNNER_SECRET;
  process.env.SCHEDULED_RUNNER_SECRET = env.SCHEDULED_RUNNER_SECRET;
  try {
    const app = express(); app.use(express.json()); let writes = 0;
    const query = async sql => { if (/UPDATE/.test(sql)) writes++; return { rows: [] }; };
    const pass = (_req, _res, next) => next();
    registerAdminActivitiesRoutes(app, { query, pool: { query }, authCore: { requireAdmin: pass, requireOwner: pass } });
    const handler = serverless(app);
    const wrong = await createDispatch(() => handler, { ...env, SCHEDULED_RUNNER_SECRET: 'wrong' })('/admin/activities/run-schedule');
    assert.equal(wrong.statusCode, 403); assert.equal(writes, 0);
    const valid = await createDispatch(() => handler, env)('/admin/activities/run-schedule');
    assert.equal(valid.statusCode, 200); assert.ok(writes > 0);
  } finally {
    if (before === undefined) delete process.env.SCHEDULED_RUNNER_SECRET;
    else process.env.SCHEDULED_RUNNER_SECRET = before;
  }
});

test('minute runner awaits inbox and flow and isolates failures without retries', async () => {
  let flow = 0, inbox = 0;
  const run = createMinuteRunner(async () => { flow++; throw Error('private-payload'); }, async () => { inbox++; return { statusCode: 200 }; });
  const r = await run(); assert.equal(r.statusCode, 500);
  assert.equal(flow, 1); assert.equal(inbox, 1); assert.doesNotMatch(r.body, /private-payload/);
  const reverse = await createMinuteRunner(async () => ({ statusCode: 200 }), async () => { throw Error('private-db'); })();
  assert.equal(reverse.statusCode, 500); assert.doesNotMatch(reverse.body, /private-db/);
  let done = false;
  await createMinuteRunner(async () => ({ statusCode: 503 }), async () => { await Promise.resolve(); done = true; return { statusCode: 200 }; })();
  assert.equal(done, true);
});

test('frequency remains unchanged; webhook rescue has only one timer', () => {
  const toml = fs.readFileSync('netlify.toml', 'utf8');
  const section = name => toml.split(`[functions."${name}"]`)[1].split(/\n\[/)[0];
  assert.match(section('scheduled-flow-runner'), /schedule = "\* \* \* \* \*"/);
  assert.match(section('scheduled-broadcast-runner'), /schedule = "\*\/5 \* \* \* \*"/);
  assert.match(section('scheduled-richmenu-runner'), /schedule = "4-59\/5 \* \* \* \*"/);
  assert.doesNotMatch(section('scheduled-line-webhook-runner'), /schedule\s*=/);
  for (const name of ['scheduled-flow-runner', 'scheduled-broadcast-runner', 'scheduled-richmenu-runner']) {
    assert.match(section(name), /included_files.*views\/\*\*/);
    assert.doesNotMatch(fs.readFileSync(`netlify/functions/${name}.js`, 'utf8'), /await fetch\(/);
  }
  // 31-day idle baseline, excluding monthly leaderboard and event-driven work.
  const oldBaseline = 31 * 1440 * 3 + 31 * 288 * 7;
  const newBaseline = 31 * 1440 + 31 * 288 * 2;
  assert.equal(oldBaseline, 196416); assert.equal(newBaseline, 62496);
  assert.ok(newBaseline < 125000);
});

function wrapper(name, dispatch, runtimeEnv = env) {
  const vm = require('node:vm');
  const sandbox = { exports: {}, process: { env: runtimeEnv }, console: { error() {} },
    require: id => { assert.equal(id, '../lib/schedulerDispatch'); return { dispatch }; } };
  vm.runInNewContext(fs.readFileSync(`netlify/functions/${name}.js`, 'utf8'), sandbox);
  return sandbox.exports.handler;
}
test('richmenu keeps all four jobs and reports partial failure, without replay', async () => {
  const paths = [];
  const run = wrapper('scheduled-richmenu-runner', async path => {
    paths.push(path); return { statusCode: paths.length === 2 ? 500 : 200, body: '{}' };
  });
  assert.equal((await run()).statusCode, 500);
  assert.deepEqual(paths, ['/admin/richmenu/run-schedule', '/admin/users/run-tag-rules', '/admin/activities/run-schedule', '/admin/recipient-lists/run-dynamic']);
});
test('broadcast dispatches exactly once; no-secret skip never invokes a send', async () => {
  let calls = 0;
  const send = async path => { calls++; assert.equal(path, '/admin/broadcast/run-scheduled'); return { statusCode: 503, body: '{}' }; };
  assert.equal((await wrapper('scheduled-broadcast-runner', send)()).statusCode, 503);
  assert.equal(calls, 1);
  assert.match((await wrapper('scheduled-broadcast-runner', send, { URL: env.URL })()).body, /skipped/);
  assert.equal(calls, 1);
});
