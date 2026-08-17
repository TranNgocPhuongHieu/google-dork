import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProxyEntry, ProxyPool, parseProxyCatalog } from '../src/proxy_pool';

const proxyConfig = {
  catalogFile: '/tmp/proxy.md',
  blockedCooldownMs: 60_000,
  failureCooldownMs: 10_000,
  successCooldownMs: 0,
  rotatingResetTimeoutMs: 1_000,
  rotatingResetWaitMs: 0,
};

function entry(kind: ProxyEntry['kind'], index: number, resetUrl?: string): ProxyEntry {
  return {
    kind,
    label: `${kind}_${index}`,
    url: `http://user:pass@127.0.0.${index}:8080`,
    resetUrl,
  };
}

test('catalog parser recognizes all proxy.md sections and masks labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-dork-proxies-'));
  const path = join(dir, 'proxy.md');
  writeFileSync(
    path,
    [
      '### Proxy private',
      'a.example:1001:user:pass',
      '### Proxy_public',
      'b.example:1002:user:pass',
      '### Proxy xoay',
      'c.example:1003:user:pass',
      'LINK RESET = https://reset.example/session',
      '### Proxy_public google',
      'd.example:1004:user:pass',
    ].join('\n'),
  );

  try {
    const entries = parseProxyCatalog(path);
    assert.deepEqual(entries.map((item) => item.kind), [
      'private',
      'public',
      'rotating',
      'google_public',
    ]);
    assert.equal(entries[2].resetUrl, 'https://reset.example/session');
    assert.equal(entries[0].label, 'private_1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('primary kinds are tried in priority order and least-used proxy wins within a kind', () => {
  const pool = new ProxyPool(
    [entry('private', 1), entry('private', 2), entry('public', 3), entry('google_public', 4)],
    proxyConfig,
  );
  const sequence: string[] = [];
  for (let index = 0; index < 6; index++) {
    const lease = pool.acquirePrimary();
    assert.ok(lease);
    sequence.push(lease.kind);
    pool.markSuccess(lease.url);
  }
  // private is exhausted only in the sense of "all leases returned", so it keeps
  // winning: lower-yield kinds are reached only when private is active/cooling.
  assert.deepEqual(sequence, [
    'private',
    'private',
    'private',
    'private',
    'private',
    'private',
  ]);
  assert.equal(pool.snapshot().find((item) => item.proxy === 'private_1')?.uses_today, 3);
  assert.equal(pool.snapshot().find((item) => item.proxy === 'private_2')?.uses_today, 3);
});

test('primary falls through to the next kind only when higher-priority kinds are unusable', () => {
  const priv = entry('private', 1);
  const gpub = entry('google_public', 2);
  const pub = entry('public', 3);
  const pool = new ProxyPool([priv, gpub, pub], proxyConfig);

  // Everything free -> private wins.
  assert.equal(pool.acquirePrimary()?.kind, 'private');
  // private now active (leased, not returned) -> google_public is next.
  assert.equal(pool.acquirePrimary()?.kind, 'google_public');
  // both higher tiers busy -> public is the last resort.
  assert.equal(pool.acquirePrimary()?.kind, 'public');
  assert.equal(pool.acquirePrimary(), undefined);

  // Returning private makes it win again immediately over the lower tiers.
  pool.markSuccess(priv.url);
  assert.equal(pool.acquirePrimary()?.kind, 'private');

  // A blocked private is skipped in favour of the next kind.
  pool.markBlocked(priv.url);
  pool.markSuccess(gpub.url);
  assert.equal(pool.acquirePrimary()?.kind, 'google_public');
});

test('markSuccess applies a cooldown only when successCooldownMs is configured', () => {
  const priv1 = entry('private', 1);
  const priv2 = entry('private', 2);

  const noCooldown = new ProxyPool([priv1], proxyConfig);
  noCooldown.markSuccess(noCooldown.acquirePrimary()!.url);
  assert.equal(noCooldown.acquirePrimary()?.label, 'private_1');

  const withCooldown = new ProxyPool([priv1, priv2], { ...proxyConfig, successCooldownMs: 60_000 });
  const first = withCooldown.acquirePrimary()!;
  withCooldown.markSuccess(first.url);
  assert.equal(
    withCooldown.snapshot().find((item) => item.proxy === first.label)?.blocked,
    true,
  );
  // The pool falls to the other entry rather than re-leasing the one that just ran.
  const second = withCooldown.acquirePrimary();
  assert.ok(second);
  assert.notEqual(second.label, first.label);
  withCooldown.markSuccess(second.url);
  assert.equal(withCooldown.acquirePrimary(), undefined);
});

test('rotating proxy is fallback only and reset is active, never implicit', async () => {
  let resetCalls = 0;
  const mockFetch: typeof fetch = async () => {
    resetCalls += 1;
    return new Response('ok', { status: 200 });
  };
  const rotating = entry('rotating', 4, 'https://reset.example/session');
  const pool = new ProxyPool(
    [entry('private', 1), entry('public', 2), entry('google_public', 3), rotating],
    proxyConfig,
    mockFetch,
  );

  for (let index = 0; index < 3; index++) {
    const lease = pool.acquirePrimary();
    assert.ok(lease);
    pool.markBlocked(lease.url);
  }
  assert.equal(pool.acquirePrimary(), undefined);
  const fallback = pool.acquireRotating();
  assert.equal(fallback?.kind, 'rotating');
  assert.equal(resetCalls, 0);

  pool.release(rotating.url);
  await pool.resetRotating(rotating);
  assert.equal(resetCalls, 1);
});

test('msUntilPrimaryAvailable reports the soonest recovery so callers can wait instead of dropping work', () => {
  const priv = entry('private', 1);
  const pub = entry('public', 2);
  const pool = new ProxyPool([priv, pub], proxyConfig);

  // Something is free right now -> no need to wait.
  assert.equal(pool.msUntilPrimaryAvailable(), 0);

  // blockedCooldownMs (60s) vs failureCooldownMs (10s): the shorter one wins.
  pool.markBlocked(priv.url);
  pool.markFailure(pub.url);
  const wait = pool.msUntilPrimaryAvailable();
  assert.ok(wait !== undefined && wait > 8_000 && wait <= 10_000, `unexpected wait=${wait}`);

  // An entry excluded for this query must not count as an upcoming slot.
  const onlyPrivateLeft = pool.msUntilPrimaryAvailable(new Set([pub.url]));
  assert.ok(
    onlyPrivateLeft !== undefined && onlyPrivateLeft > 50_000,
    `unexpected wait=${onlyPrivateLeft}`,
  );

  // Every candidate excluded -> undefined, meaning "do not wait".
  assert.equal(pool.msUntilPrimaryAvailable(new Set([priv.url, pub.url])), undefined);
  assert.equal(new ProxyPool([], proxyConfig).msUntilPrimaryAvailable(), undefined);

  // A leased (active) proxy will not free itself on a timer either.
  const busy = new ProxyPool([entry('private', 3)], proxyConfig);
  busy.acquirePrimary();
  assert.equal(busy.msUntilPrimaryAvailable(), undefined);

  // Rotating is not a primary kind, so it never satisfies a primary wait.
  const rotatingOnly = new ProxyPool([entry('rotating', 4)], proxyConfig);
  assert.equal(rotatingOnly.msUntilPrimaryAvailable(), undefined);
});

test('probe subset uses only requested non-rotating labels without changing the source pool', () => {
  const pool = new ProxyPool(
    [entry('private', 1), entry('private', 2), entry('public', 3), entry('google_public', 4)],
    proxyConfig,
  );
  const subset = pool.selectProbeLabels(['private_2', 'public_3', 'google_public_4']);

  assert.deepEqual(
    subset.snapshot().map((state) => state.proxy),
    ['private_2', 'public_3', 'google_public_4'],
  );
  assert.equal(pool.snapshot().length, 4);
  assert.throws(() => pool.selectProbeLabels(['private_1', 'missing_2']), /requested probe labels/);

  const withRotating = new ProxyPool([entry('private', 1), entry('rotating', 2)], proxyConfig);
  assert.throws(() => withRotating.selectProbeLabels(['private_1', 'rotating_2']), /requested probe labels/);
});
