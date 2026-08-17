import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPreflightAudioConfig,
  PreflightAudioCollector,
  selectPreflightLabels,
} from '../src/preflight_audio';
import { inspectRecaptchaAudioControl, captureRecaptchaAudio } from '../src/google_crawler';

function preflightEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROBE_CONFIRM_LIVE: 'true',
    SEARCH_SITES: 'facebook.com',
    SLUGS: 'da_nang',
    SEARCH_DATE_FROM: '2026-07-01',
    SEARCH_DATE_TO: '2026-07-01',
    ...overrides,
  };
}

function controlFrame(state: { count: number; visible: boolean; enabled: boolean }) {
  return {
    locator: () => ({
      first: () => ({
        count: async () => state.count,
        isVisible: async () => state.visible,
        isEnabled: async () => state.enabled,
      }),
    }),
  } as unknown as Parameters<typeof captureRecaptchaAudio>[1];
}

test('preflight config stays inside its cheap bounds and reuses the G6 query window', () => {
  const config = loadPreflightAudioConfig(preflightEnv());

  assert.equal(config.maxLabels, 20);
  assert.equal(config.maxDurationMs, 600_000);
  assert.equal(config.labelTimeoutMs, 45_000);
  assert.equal(config.probe.dateFrom, '2026-07-01');

  assert.throws(
    () => loadPreflightAudioConfig(preflightEnv({ PREFLIGHT_MAX_LABELS: '41' })),
    /PREFLIGHT_MAX_LABELS must be between 1 and 40/,
  );
  assert.throws(
    () => loadPreflightAudioConfig(preflightEnv({ PREFLIGHT_LABEL_TIMEOUT_MS: '121000' })),
    /PREFLIGHT_LABEL_TIMEOUT_MS must be between 5000 and 120000/,
  );
  assert.throws(
    () => loadPreflightAudioConfig(preflightEnv({ PREFLIGHT_MAX_DURATION_MS: '1800001' })),
    /PREFLIGHT_MAX_DURATION_MS must be between 10000 and 1800000/,
  );
});

test('label selection drops rotating, duplicate and URL-shaped entries', () => {
  const config = loadPreflightAudioConfig(preflightEnv({ PREFLIGHT_MAX_LABELS: '3' }));
  const selected = selectPreflightLabels(
    [
      { label: 'private_1', kind: 'private' },
      { label: 'private_1', kind: 'private' },
      { label: 'rotating_1', kind: 'rotating' },
      { label: 'http://user:password@proxy.example:8080', kind: 'public' },
      { label: 'public_2', kind: 'public' },
      { label: 'google_public_3', kind: 'google_public' },
      { label: 'private_4', kind: 'private' },
    ],
    config,
  );

  assert.deepEqual(
    selected.map((entry) => entry.label),
    ['private_1', 'public_2', 'google_public_3'],
  );
});

test('label selection honours an explicit PROBE_PROXY_LABELS subset', () => {
  const config = loadPreflightAudioConfig(
    preflightEnv({ PROBE_PROXY_LABELS: 'private_1,public_2,google_public_3' }),
  );
  const selected = selectPreflightLabels(
    [
      { label: 'private_1', kind: 'private' },
      { label: 'private_9', kind: 'private' },
      { label: 'public_2', kind: 'public' },
    ],
    config,
  );

  assert.deepEqual(
    selected.map((entry) => entry.label),
    ['private_1', 'public_2'],
  );
});

test('report declares no-write safety and never leaks an unsafe label', () => {
  const collector = new PreflightAudioCollector(1_000);

  collector.record({ label: 'private_1', kind: 'private', outcome: 'audio_control_enabled' });
  collector.record({
    label: 'http://user:password@proxy.example:8080',
    kind: 'public',
    outcome: 'audio_control_enabled',
  });

  const report = collector.report(2, 'completed', 4_000);
  const serialized = JSON.stringify(report);

  assert.equal(report.labels.checked, 1);
  assert.deepEqual(report.labels.audio_enabled, ['private_1']);
  assert.equal(report.run.elapsed_ms, 3_000);
  assert.deepEqual(report.safety, {
    kafka_enabled: false,
    paid_captcha_enabled: false,
    database_writes: 0,
    kafka_publishes: 0,
    audio_downloaded: false,
    solver_invoked: false,
  });
  assert.doesNotMatch(serialized, /user:password/);
});

test('verdict needs three audio-enabled labels, matching the G6 proxy-diversity bar', () => {
  const enabled = new PreflightAudioCollector(0);
  for (const label of ['private_1', 'public_2', 'google_public_3']) {
    enabled.record({ label, kind: 'private', outcome: 'audio_control_enabled' });
  }
  assert.equal(enabled.report(3, 'completed', 1).run.verdict, 'audio_reachable');

  const twoOnly = new PreflightAudioCollector(0);
  twoOnly.record({ label: 'private_1', kind: 'private', outcome: 'audio_control_enabled' });
  twoOnly.record({ label: 'public_2', kind: 'public', outcome: 'audio_control_enabled' });
  assert.equal(twoOnly.report(2, 'completed', 1).run.verdict, 'inconclusive');
});

test('all-disabled sweep reproduces the t1220 blocker as audio_blocked', () => {
  const collector = new PreflightAudioCollector(0);
  for (let index = 1; index <= 16; index++) {
    collector.record({
      label: `private_${index}`,
      kind: 'private',
      outcome: 'audio_control_disabled',
    });
  }

  const report = collector.report(16, 'completed', 1);
  assert.equal(report.run.verdict, 'audio_blocked');
  assert.equal(report.outcomes.audio_control_disabled, 16);
  assert.equal(report.outcomes.audio_control_enabled, 0);
  assert.deepEqual(report.labels.audio_enabled, []);
});

test('a sweep that never reached a challenge stays inconclusive, not audio_blocked', () => {
  const collector = new PreflightAudioCollector(0);
  collector.record({ label: 'private_1', kind: 'private', outcome: 'no_captcha' });
  collector.record({ label: 'public_2', kind: 'public', outcome: 'navigation_failed' });

  assert.equal(collector.report(2, 'completed', 1).run.verdict, 'inconclusive');
});

test('collector stops at its own time bound', () => {
  const config = loadPreflightAudioConfig(preflightEnv({ PREFLIGHT_MAX_DURATION_MS: '10000' }));
  const collector = new PreflightAudioCollector(1_000);

  assert.equal(collector.shouldStop(config, 5_000), undefined);
  assert.equal(collector.shouldStop(config, 11_000), 'time_limit');
});

test('audio-control inspection reports the same codes the capture path reports', async () => {
  assert.equal(
    await inspectRecaptchaAudioControl(controlFrame({ count: 0, visible: false, enabled: false })),
    'audio_control_unavailable',
  );
  assert.equal(
    await inspectRecaptchaAudioControl(controlFrame({ count: 1, visible: false, enabled: false })),
    'audio_control_not_visible',
  );
  assert.equal(
    await inspectRecaptchaAudioControl(controlFrame({ count: 1, visible: true, enabled: false })),
    'audio_control_disabled',
  );
  assert.equal(
    await inspectRecaptchaAudioControl(controlFrame({ count: 1, visible: true, enabled: true })),
    'audio_control_enabled',
  );

  // The shared helper must keep captureRecaptchaAudio's contract byte-identical.
  const page = {} as unknown as Parameters<typeof captureRecaptchaAudio>[0];
  assert.deepEqual(
    await captureRecaptchaAudio(page, controlFrame({ count: 1, visible: true, enabled: false }), false),
    { status: 'failure', reasonCode: 'audio_control_disabled' },
  );
});
