import test from 'node:test';
import assert from 'node:assert/strict';

import { getProvince, type Tier } from '../src/entity_registry';
import {
  buildBackfillPlan,
  loadBackfillConfig,
  planFingerprint,
} from '../src/serper_en_backfill';

// The plan builder is expected to be pure: execution belongs to the CLI layer.
// This keeps DRY_RUN checks independent of Serper, PostgreSQL, and Kafka.
const BASE_ENV: NodeJS.ProcessEnv = {
  DRY_RUN: 'true',
  BACKFILL_RANGE: '2026-05-01:2026-07-31',
};

function loadConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadBackfillConfig({ ...BASE_ENV, ...overrides });
}

function build(overrides: NodeJS.ProcessEnv = {}) {
  return buildBackfillPlan(loadConfig(overrides));
}

const DEFAULT_CONFIG = loadConfig();

test('default EN backfill plan has seven windows and preserves cardinality', () => {
  const plan = build();

  assert.equal(plan.windows.length, 7);
  assert.equal(plan.intentCount, 3);
  assert.equal(
    plan.items.length,
    plan.chunks.length * plan.intentCount * plan.windows.length,
  );
  assert.equal(plan.windows[0].dateFrom, DEFAULT_CONFIG.range.dateFrom);
  assert.equal(plan.windows[plan.windows.length - 1].dateTo, DEFAULT_CONFIG.range.dateTo);
});

test('tier filters use getProvince and retain the unfiltered tier allocation', () => {
  const all = build();
  const counts: Record<Tier, number> = { A: 0, B: 0, C: 0 };

  for (const chunk of all.chunks) {
    const province = getProvince(chunk.provinceSlug);
    assert.ok(province, `unknown province slug: ${chunk.provinceSlug}`);
    assert.equal(chunk.tier, province.tier);
    counts[province.tier]++;
  }

  for (const tier of ['A', 'B', 'C'] as const) {
    const filtered = build({ BACKFILL_TIERS: tier });

    assert.equal(filtered.chunks.length, counts[tier], `tier ${tier}`);
    assert.ok(filtered.chunks.length > 0, `tier ${tier} should be represented`);
    for (const chunk of filtered.chunks) {
      assert.equal(getProvince(chunk.provinceSlug)?.tier, tier, `tier ${tier}`);
    }
    assert.equal(
      filtered.items.length,
      filtered.chunks.length * filtered.intentCount * filtered.windows.length,
      `tier ${tier}`,
    );
  }
});

test('slug and window filters keep only the requested plan slice', () => {
  const plan = build({
    BACKFILL_ONLY_SLUGS: 'da_nang',
    BACKFILL_ONLY_WINDOW_INDEXES: '0,6',
  });

  assert.ok(plan.chunks.length > 0);
  assert.deepEqual([...new Set(plan.chunks.map((chunk) => chunk.provinceSlug))], ['da_nang']);
  assert.deepEqual(plan.windows.map((window) => window.index), [0, 6]);
  assert.equal(plan.items.length, plan.chunks.length * 3 * 2);
  for (const item of plan.items) {
    assert.equal(item.chunk.provinceSlug, 'da_nang');
    assert.ok([0, 6].includes(item.window.index));
  }
});

test('filtered and unfiltered plans share the checkpoint fingerprint', () => {
  const fullConfig = loadConfig();
  const fullPlan = buildBackfillPlan(fullConfig);
  const filteredConfig = loadConfig({
    BACKFILL_ONLY_SLUGS: 'da_nang',
    BACKFILL_ONLY_WINDOW_INDEXES: '0,6',
  });
  const filteredPlan = buildBackfillPlan(filteredConfig);

  assert.equal(planFingerprint(fullConfig, fullPlan), planFingerprint(filteredConfig, filteredPlan));
});

test('DRY_RUN builds a plan without invoking network access', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    fetchCalls++;
    throw new Error('network access is forbidden in DRY_RUN');
  }) as typeof fetch;

  try {
    const plan = build();

    assert.ok(plan.items.length > 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
