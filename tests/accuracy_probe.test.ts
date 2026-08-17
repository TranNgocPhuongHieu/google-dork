import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AccuracyProbeCollector,
  applyAccuracyProbeSafetyGuards,
  buildAccuracyProbeQueries,
  loadAccuracyProbeConfig,
} from '../src/accuracy_probe';
import { loadConfig } from '../src/config';
import { createProbeCancellation, probeDelayMs, waitForAbortableProbeDelay } from '../accuracy_probe';

function probeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROBE_CONFIRM_LIVE: 'true',
    CAPTCHA_LOCAL_AUDIO_ENABLED: 'true',
    SEARCH_SITES: 'facebook.com,instagram.com',
    SLUGS: 'da_nang',
    SEARCH_DATE_FROM: '2026-07-01',
    SEARCH_DATE_TO: '2026-07-01',
    PROBE_MAX_QUERIES: '10',
    PROBE_MAX_DURATION_MS: '60000',
    PROBE_TARGET_AUDIO_CHALLENGES: '20',
    ...overrides,
  };
}

test('accuracy probe validates its bounded live configuration and uses production query builders', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const queries = buildAccuracyProbeQueries(config);

  assert.equal(config.maxQueries, 10);
  assert.equal(config.maxDurationMs, 60_000);
  assert.equal(config.probeProxyLabels, undefined);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].maxPages, 1);
  assert.match(queries[0].query, /site:facebook\.com/);
  assert.match(queries[0].query, /after:2026-06-30 before:2026-07-02/);
});

test('accuracy probe rejects unbounded or unsupported live input before crawler import', () => {
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ PROBE_MAX_QUERIES: '101' })),
    /PROBE_MAX_QUERIES must be between 1 and 100/,
  );
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ PROBE_TARGET_AUDIO_CHALLENGES: '19' })),
    /PROBE_TARGET_AUDIO_CHALLENGES must be between 20 and 100/,
  );
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ PROBE_PROXY_LABELS: 'private_1,public_2' })),
    /PROBE_PROXY_LABELS must contain 3 to 20 unique safe proxy labels/,
  );
  assert.throws(
    () =>
      loadAccuracyProbeConfig(
        probeEnv({ PROBE_PROXY_LABELS: 'private_1,http://bad.example,public_2' }),
      ),
    /PROBE_PROXY_LABELS must contain 3 to 20 unique safe proxy labels/,
  );
  assert.throws(
    () =>
      loadAccuracyProbeConfig(
        probeEnv({ PROBE_PROXY_LABELS: 'private_1,public_2,private_1' }),
      ),
    /PROBE_PROXY_LABELS must contain 3 to 20 unique safe proxy labels/,
  );
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ SEARCH_SITES: 'facebook.com,example.com' })),
    /SEARCH_SITES must contain only/,
  );
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ SLUGS: 'unknown_slug' })),
    /SLUGS must contain known province slugs only/,
  );
  assert.throws(
    () => loadAccuracyProbeConfig(probeEnv({ SEARCH_DATE_TO: '2026-06-30' })),
    /SEARCH_DATE_TO must be greater than or equal to SEARCH_DATE_FROM/,
  );
});

test('accuracy probe accepts an explicit opaque proxy subset', () => {
  const config = loadAccuracyProbeConfig(
    probeEnv({ PROBE_PROXY_LABELS: 'private_1, public_2, google_public_3' }),
  );

  assert.deepEqual(config.probeProxyLabels, ['private_1', 'public_2', 'google_public_3']);
});

test('probe cancellation aborts active work with a distinct shutdown reason', () => {
  const cancellation = createProbeCancellation(60_000);
  try {
    assert.equal(cancellation.signal.aborted, false);
    cancellation.requestShutdown();
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(cancellation.stopReason(), 'shutdown');
  } finally {
    cancellation.dispose();
  }
});

test('probe pacing preserves its delay bounds and can be aborted before another query starts', async () => {
  assert.equal(probeDelayMs(30_000, 60_000, () => 0), 30_000);
  assert.equal(probeDelayMs(30_000, 60_000, () => 1), 60_000);
  assert.equal(probeDelayMs(5, 5, () => 0.5), 5);

  const controller = new AbortController();
  const pending = waitForAbortableProbeDelay(60_000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
});

test('accuracy probe safety guards force Kafka and paid CAPTCHA off while keeping local disabled by default', () => {
  const env = probeEnv({
    KAFKA_ENABLED: 'true',
    CAPTCHA_API_KEY: 'must-not-survive',
    CAPTCHA_LOCAL_AUDIO_ENABLED: '',
    SEARCH_WORKERS: '9',
    SEARCH_MAX_PAGES: '9',
    SEARCH_TIER_A_MAX_PAGES: '9',
    SEARCH_TIER_B_MAX_PAGES: '6',
    SEARCH_TIER_C_MAX_PAGES: '3',
    SEARCH_RECOVERY_ROTATING_ROUNDS: '2',
    SEARCH_RECOVERY_WAIT_MS: '30000',
  });

  applyAccuracyProbeSafetyGuards(env);

  assert.equal(env.KAFKA_ENABLED, 'false');
  assert.equal(env.CAPTCHA_API_KEY, '');
  assert.equal(env.CAPTCHA_LOCAL_AUDIO_ENABLED, 'false');
  assert.equal(env.SEARCH_WORKERS, '1');
  assert.equal(env.SEARCH_MAX_PAGES, '1');
  assert.equal(env.SEARCH_TIER_A_MAX_PAGES, '1');
  assert.equal(env.SEARCH_TIER_B_MAX_PAGES, '1');
  assert.equal(env.SEARCH_TIER_C_MAX_PAGES, '1');
  assert.equal(env.SEARCH_RECOVERY_ROTATING_ROUNDS, '0');
  assert.equal(env.SEARCH_RECOVERY_WAIT_MS, '0');
  const loaded = loadConfig(env);
  assert.equal(loaded.search.recoveryRotatingRounds, 0);
  assert.equal(loaded.search.recoveryWaitMs, 0);
});

test('collector redacts unsafe event fields and reports the G6 acceptance metrics', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const collector = new AccuracyProbeCollector(1_000, 10);

  collector.recordQueryStarted();
  collector.recordQueryCompleted({
    succeeded: true,
    blocked: false,
    organicResults: 8,
    eligibleResults: 3,
  });
  const audioLabels = ['private_1', 'public_2', 'google_public_3'];
  for (let attempt = 0; attempt < 20; attempt++) {
    const proxyLabel = audioLabels[attempt % audioLabels.length];
    collector.recordCaptchaEvent({ event: 'captcha_audio_offered', proxyLabel });
    collector.recordCaptchaEvent({ event: 'captcha_local_attempt', proxyLabel });
    collector.recordCaptchaEvent({
      event: 'captcha_local_result',
      proxyLabel,
      status: attempt === 0 ? 'success' : 'failure',
      reasonCode: attempt === 0 ? undefined : 'timeout',
      durationMs: attempt === 0 ? 30_000 : 59_000,
    });
  }
  collector.recordCaptchaEvent({
    event: 'captcha_local_result',
    proxyLabel: 'http://user:password@proxy.example:8080',
    status: 'failure',
    reasonCode: 'secret-value',
    durationMs: 1,
  });

  const report = collector.report(config, 10, 'target_reached', 61_000);
  const serialized = JSON.stringify(report);

  assert.equal(report.captcha.audio_offered, 20);
  assert.equal(report.captcha.local_solved, 1);
  assert.equal(report.captcha.local_failed, 20);
  assert.equal(report.captcha.local_duration_ms.p50, 59_000);
  assert.equal(report.captcha.local_duration_ms.p95, 59_000);
  assert.deepEqual(report.captcha.audio_proxy_labels, ['google_public_3', 'private_1', 'public_2']);
  assert.deepEqual(report.captcha.proxy_labels, ['google_public_3', 'private_1', 'public_2']);
  assert.deepEqual(report.captcha.outcomes, { solved: 1, timeout: 19, unknown: 1 });
  assert.equal(report.run.local_success_rate, 1 / 20);
  assert.equal(report.run.gate, 'failed');
  assert.equal(report.safety.kafka_publishes, 0);
  assert.equal(report.safety.database_writes, 0);
  assert.deepEqual(report.process.cleanup, {
    worker_restarts: 0,
    circuit_open: false,
    active_children: 0,
    pending_requests: 0,
    active_temp_dirs: 0,
  });
  assert.doesNotMatch(serialized, /user:password|secret-value/);
});

test('regression: capture-stage failures never inflate local_failed (G6 t1220 contradiction)', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const collector = new AccuracyProbeCollector(1_000, 10);

  // Reproduces run t1220: 35 audio_response_timeout + 35 audio_control_disabled,
  // zero audio ever handed to the solver. Old build reported
  // local_attempted=0 / local_failed=70, which is arithmetically impossible.
  for (let attempt = 0; attempt < 35; attempt++) {
    collector.recordCaptchaEvent({
      event: 'captcha_local_result',
      proxyLabel: 'private_1',
      status: 'failure',
      reasonCode: 'audio_response_timeout',
      stage: 'capture',
      durationMs: 20_000,
    });
    // Same shape without an explicit stage: older producers must classify identically.
    collector.recordCaptchaEvent({
      event: 'captcha_local_result',
      proxyLabel: 'private_2',
      status: 'failure',
      reasonCode: 'audio_control_disabled',
    });
  }

  const report = collector.report(config, 93, 'query_limit', 2_000);

  assert.equal(report.captcha.audio_offered, 0);
  assert.equal(report.captcha.local_attempted, 0);
  assert.equal(report.captcha.local_solved, 0);
  // The invariant the old build violated.
  assert.equal(report.captcha.local_failed, 0);
  assert.ok(report.captcha.local_failed <= report.captcha.local_attempted);
  assert.equal(report.captcha.capture_failed, 70);
  assert.deepEqual(report.captcha.capture_outcomes, {
    audio_response_timeout: 35,
    audio_control_disabled: 35,
  });
  // Capture-stage durations are not solver latency.
  assert.equal(report.captcha.local_duration_ms.count, 0);
  assert.equal(report.captcha.local_duration_ms.p95, null);
  assert.equal(report.run.local_success_rate, null);
  assert.equal(report.run.gate, 'inconclusive');
});

test('regression: one capture failure per attempt, no double-counted reason code', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const collector = new AccuracyProbeCollector(1_000, 10);

  collector.recordCaptchaEvent({
    event: 'captcha_local_result',
    proxyLabel: 'private_1',
    status: 'failure',
    reasonCode: 'audio_control_disabled',
    stage: 'capture',
  });

  const report = collector.report(config, 1, 'query_limit', 2_000);
  const total = Object.values(report.captcha.outcomes).reduce((sum, count) => sum + count, 0);

  assert.equal(total, 1);
  assert.equal(report.captcha.capture_failed, 1);
  assert.deepEqual(report.captcha.capture_outcomes, { audio_control_disabled: 1 });
});

test('regression: solve-stage failures still count against the solver', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const collector = new AccuracyProbeCollector(1_000, 10);

  collector.recordCaptchaEvent({ event: 'captcha_audio_offered', proxyLabel: 'private_1' });
  collector.recordCaptchaEvent({ event: 'captcha_local_attempt', proxyLabel: 'private_1' });
  collector.recordCaptchaEvent({
    event: 'captcha_local_result',
    proxyLabel: 'private_1',
    status: 'failure',
    reasonCode: 'answer_verification_unsolved',
    stage: 'solve',
    durationMs: 12_000,
  });
  // Unrecognized reason codes are attributed to the solver, not to capture.
  collector.recordCaptchaEvent({ event: 'captcha_audio_offered', proxyLabel: 'private_1' });
  collector.recordCaptchaEvent({ event: 'captcha_local_attempt', proxyLabel: 'private_1' });
  collector.recordCaptchaEvent({
    event: 'captcha_local_result',
    proxyLabel: 'private_1',
    status: 'failure',
    reasonCode: 'brand_new_reason',
    durationMs: 13_000,
  });

  const report = collector.report(config, 2, 'query_limit', 2_000);

  assert.equal(report.captcha.local_attempted, 2);
  assert.equal(report.captcha.local_failed, 2);
  assert.equal(report.captcha.capture_failed, 0);
  assert.deepEqual(report.captcha.capture_outcomes, {});
  assert.equal(report.captcha.local_duration_ms.count, 2);
});

test('collector stops at the time bound and keeps a canary without three proxies inconclusive', () => {
  const config = loadAccuracyProbeConfig(probeEnv({ PROBE_MAX_DURATION_MS: '1000' }));
  const collector = new AccuracyProbeCollector(1_000, 10);

  collector.recordCaptchaEvent({ event: 'captcha_audio_offered', proxyLabel: 'private_1' });
  collector.recordCaptchaEvent({
    event: 'captcha_local_result',
    proxyLabel: 'private_1',
    status: 'success',
    durationMs: 20_000,
  });

  assert.equal(collector.shouldStop(config, 2_000), 'time_limit');
  assert.equal(collector.report(config, 10, 'time_limit', 2_000).run.gate, 'inconclusive');
});

test('collector requires three distinct proxies that actually offered audio', () => {
  const config = loadAccuracyProbeConfig(probeEnv());
  const collector = new AccuracyProbeCollector(1_000, 10);

  for (let attempt = 0; attempt < 20; attempt++) {
    collector.recordCaptchaEvent({ event: 'captcha_audio_offered', proxyLabel: 'private_1' });
    collector.recordCaptchaEvent({
      event: 'captcha_local_result',
      proxyLabel: 'private_1',
      status: 'success',
      durationMs: 1_000,
    });
  }
  collector.recordCaptchaEvent({ event: 'captcha_hard_block', proxyLabel: 'public_2' });
  collector.recordCaptchaEvent({ event: 'captcha_hard_block', proxyLabel: 'google_public_3' });

  const report = collector.report(config, 20, 'target_reached', 2_000);
  assert.deepEqual(report.captcha.audio_proxy_labels, ['private_1']);
  assert.deepEqual(report.captcha.proxy_labels, ['google_public_3', 'private_1', 'public_2']);
  assert.equal(report.run.gate, 'inconclusive');
});
