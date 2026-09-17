/*
 * Campaign Testing 的純邏輯。
 *
 * 保持在 route 之外，讓「分組不重複、比例正確、勝出邏輯可重現」都能用 unit test
 * 驗證。資料庫只儲存已經物化過的結果，不能在後續重算受眾而改變實驗名單。
 */

const VARIANTS = ['a', 'b', 'c'];

function integerInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function activeVariants(variantCount) {
  return variantCount === 3 ? ['a', 'b', 'c'] : ['a', 'b'];
}

function normalizeCampaignExperiment(raw) {
  if (!raw || raw.enabled !== true) return { ok: true, value: null };
  const variantCount = integerInRange(raw.variant_count, 2, 3);
  if (!variantCount) return { ok: false, error: 'experiment_variant_count_invalid' };

  const metric = String(raw.metric || 'ctr').toLowerCase();
  // Booking 與 LINE user id 尚未有可信的一對一串接；不能假裝可以選 Winner。
  if (metric === 'booking_conversion') return { ok: false, error: 'booking_conversion_not_available' };
  if (metric !== 'ctr') return { ok: false, error: 'experiment_metric_invalid' };

  const observationHours = integerInRange(raw.observation_hours, 1, 168);
  if (!observationHours) return { ok: false, error: 'experiment_observation_hours_invalid' };

  const input = raw.allocations || {};
  const allocations = {
    a: integerInRange(input.a, 0, 100),
    b: integerInRange(input.b, 0, 100),
    c: integerInRange(input.c, 0, 100),
    holdout: integerInRange(input.holdout, 0, 100)
  };
  if (Object.values(allocations).some((n) => n === null)) {
    return { ok: false, error: 'experiment_allocation_invalid' };
  }
  if (variantCount === 2 && allocations.c !== 0) {
    return { ok: false, error: 'experiment_c_allocation_requires_three_variants' };
  }
  const variants = activeVariants(variantCount);
  if (variants.some((v) => allocations[v] <= 0) || allocations.holdout <= 0) {
    return { ok: false, error: 'experiment_each_group_must_be_positive' };
  }
  if (allocations.a + allocations.b + allocations.c + allocations.holdout !== 100) {
    return { ok: false, error: 'experiment_allocation_must_total_100' };
  }

  return {
    ok: true,
    value: {
      enabled: true,
      variantCount,
      metric: 'ctr',
      observationHours,
      allocations,
      // 真正的觀察期要等最後一位測試收件人送完才開始。建立／排程時間不能先吃掉觀察時數。
      observationStartedAt: null,
      winnerAt: null,
      winnerMode: 'auto',
      winnerVariant: null,
      releasedBroadcastId: null
    }
  };
}

function startObservationWindow(experiment, now = new Date()) {
  if (!experiment || experiment.enabled !== true) return experiment || null;
  // 已開始的實驗不可因重試、排程重跑而把截止時間往後延。
  if (experiment.winnerAt) return experiment;
  const observationHours = integerInRange(experiment.observationHours, 1, 168);
  if (!observationHours) throw new Error('experiment_observation_hours_invalid');
  const startedAt = now.toISOString();
  return {
    ...experiment,
    observationStartedAt: startedAt,
    winnerAt: new Date(now.getTime() + observationHours * 60 * 60 * 1000).toISOString()
  };
}

function allocationCounts(total, allocations, variants) {
  if (!Number.isInteger(total) || total < variants.length + 1) {
    throw new Error('experiment_needs_min_recipients');
  }
  const names = variants.concat('holdout');
  const exact = names.map((name) => ({ name, exact: total * allocations[name] / 100 }));
  const counts = {};
  let assigned = 0;
  exact.forEach((row) => { counts[row.name] = Math.floor(row.exact); assigned += counts[row.name]; });
  exact
    .slice()
    .sort((left, right) => (right.exact - Math.floor(right.exact)) - (left.exact - Math.floor(left.exact)))
    .slice(0, total - assigned)
    .forEach((row) => { counts[row.name] += 1; });

  // 小樣本時仍要讓每一測試版以及保留名單都真的存在。
  names.forEach((name) => {
    if (counts[name] > 0) return;
    const donor = names
      .filter((candidate) => counts[candidate] > 1)
      .sort((left, right) => counts[right] - counts[left])[0];
    if (!donor) throw new Error('experiment_needs_min_recipients');
    counts[donor] -= 1;
    counts[name] = 1;
  });
  return counts;
}

function assignExperimentVariants(total, allocations, variantCount, random = Math.random) {
  const variants = activeVariants(variantCount);
  const counts = allocationCounts(total, allocations, variants);
  const pool = [];
  Object.keys(counts).forEach((name) => {
    for (let i = 0; i < counts[name]; i += 1) pool.push(name);
  });
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { assignments: pool, counts };
}

function pickCtrWinner(rows, variants) {
  const map = new Map((rows || []).map((row) => [row.variant, row]));
  let winner = variants[0];
  let winnerRate = -1;
  variants.forEach((variant) => {
    const row = map.get(variant) || {};
    const sent = Number(row.sent_ok || row.sent || 0);
    const clickers = Number(row.clickers || 0);
    const rate = sent > 0 ? clickers / sent : 0;
    // variants 是 A → B → C，刻意不在平手覆寫，規則可預期且可稽核。
    if (rate > winnerRate) {
      winner = variant;
      winnerRate = rate;
    }
  });
  return winner;
}

module.exports = {
  activeVariants,
  normalizeCampaignExperiment,
  startObservationWindow,
  allocationCounts,
  assignExperimentVariants,
  pickCtrWinner
};
