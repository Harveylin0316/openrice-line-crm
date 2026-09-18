const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeCampaignExperiment,
  startObservationWindow,
  assignExperimentVariants,
  pickCtrWinner,
  resolveAbCtrWinner
} = require('../src/core/campaignExperiment');

function validExperiment(overrides = {}) {
  return {
    enabled: true,
    variant_count: 2,
    observation_hours: 24,
    metric: 'ctr',
    allocations: { a: 10, b: 10, c: 0, holdout: 80 },
    ...overrides
  };
}

test('Campaign Testing validates a real 10/10/80 CTR experiment and waits to start observation', () => {
  const result = normalizeCampaignExperiment(validExperiment());
  assert.equal(result.ok, true);
  assert.equal(result.value.observationStartedAt, null);
  assert.equal(result.value.winnerAt, null);
  assert.equal(result.value.metric, 'ctr');
});

test('觀察期只在測試名單送完後開始，重試不延後截止時間', () => {
  const experiment = {
    enabled: true,
    observationHours: 24,
    observationStartedAt: null,
    winnerAt: null
  };
  const started = startObservationWindow(experiment, new Date('2026-09-17T02:00:00.000Z'));
  assert.equal(started.observationStartedAt, '2026-09-17T02:00:00.000Z');
  assert.equal(started.winnerAt, '2026-09-18T02:00:00.000Z');
  assert.deepEqual(
    startObservationWindow(started, new Date('2026-09-17T03:00:00.000Z')),
    started
  );
});

test('Campaign Testing refuses invalid allocation totals and unavailable booking conversion', () => {
  assert.equal(normalizeCampaignExperiment(validExperiment({ allocations: { a: 10, b: 10, c: 0, holdout: 70 } })).error, 'experiment_allocation_must_total_100');
  assert.equal(normalizeCampaignExperiment(validExperiment({ metric: 'booking_conversion' })).error, 'booking_conversion_not_available');
});

test('Campaign Testing random assignment is exhaustive, disjoint and honors 10/10/80', () => {
  const out = assignExperimentVariants(100, { a: 10, b: 10, c: 0, holdout: 80 }, 2, () => 0.25);
  assert.equal(out.assignments.length, 100);
  assert.deepEqual(out.counts, { a: 10, b: 10, holdout: 80 });
  assert.equal(out.assignments.filter((v) => v === 'a').length, 10);
  assert.equal(out.assignments.filter((v) => v === 'b').length, 10);
  assert.equal(out.assignments.filter((v) => v === 'holdout').length, 80);
});

test('Campaign Testing supports A/B/C and always leaves every group represented in a small valid audience', () => {
  const out = assignExperimentVariants(4, { a: 1, b: 1, c: 1, holdout: 97 }, 3, () => 0.5);
  assert.deepEqual(Object.keys(out.counts).sort(), ['a', 'b', 'c', 'holdout']);
  assert.ok(Object.values(out.counts).every((n) => n >= 1));
});

test('CTR winner uses rate rather than raw clicks, with A as an auditable tie-breaker', () => {
  assert.equal(pickCtrWinner([
    { variant: 'a', sent_ok: 10, clickers: 2 },
    { variant: 'b', sent_ok: 100, clickers: 10 }
  ], ['a', 'b']), 'a');
  assert.equal(pickCtrWinner([
    { variant: 'a', sent_ok: 100, clickers: 10 },
    { variant: 'b', sent_ok: 10, clickers: 1 },
    { variant: 'c', sent_ok: 50, clickers: 5 }
  ], ['a', 'b', 'c']), 'a');
});

test('一般 A/B 平手或零點擊時不虛構勝出版，只有 CTR 確實較高才勝出', () => {
  assert.deepEqual(resolveAbCtrWinner([
    { variant: 'a', sent_ok: 645, clickers: 0 },
    { variant: 'b', sent_ok: 646, clickers: 0 }
  ]).winner, null);
  assert.equal(resolveAbCtrWinner([
    { variant: 'a', sent_ok: 100, clickers: 10 },
    { variant: 'b', sent_ok: 50, clickers: 5 }
  ]).reason, 'tie');
  assert.equal(resolveAbCtrWinner([
    { variant: 'a', sent_ok: 100, clickers: 2 },
    { variant: 'b', sent_ok: 20, clickers: 1 }
  ]).winner, 'b');
  assert.equal(resolveAbCtrWinner([
    { variant: 'a', sent_ok: 0, clickers: 0 },
    { variant: 'b', sent_ok: 20, clickers: 1 }
  ]).reason, 'insufficient_delivery');
});

test('Campaign Testing UI exposes A/B/C, custom ratios, observation window and per-version test push', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin_broadcast.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-broadcast.js'), 'utf8');
  [
    'campaign-test-enable', 'campaign-variant-count', 'campaign-weight-holdout',
    'campaign-observation-hours', 'variant-c-pane', 'test-campaign-variant'
  ].forEach((id) => assert.match(view, new RegExp(`id="${id}"`)));
  assert.match(script, /variant_c_message_config/);
  assert.match(script, /collectSelectedTestMessageConfig/);
  assert.match(script, /Campaign Testing 目前請使用一般訊息編輯器/);
});
