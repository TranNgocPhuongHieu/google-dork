import { AccuracyProbeConfig, loadAccuracyProbeConfig } from './accuracy_probe';

/**
 * Result of looking at the reCAPTCHA audio control for one proxy label WITHOUT
 * clicking it. Nothing here downloads audio or runs the solver, so a full sweep
 * costs one navigation per label instead of a full G6 canary run.
 */
export type PreflightAudioOutcome =
  | 'audio_control_enabled'
  | 'audio_control_disabled'
  | 'audio_control_not_visible'
  | 'audio_control_unavailable'
  | 'challenge_unavailable'
  | 'hard_block'
  | 'no_captcha'
  | 'navigation_failed';

export const PREFLIGHT_AUDIO_OUTCOMES: readonly PreflightAudioOutcome[] = [
  'audio_control_enabled',
  'audio_control_disabled',
  'audio_control_not_visible',
  'audio_control_unavailable',
  'challenge_unavailable',
  'hard_block',
  'no_captcha',
  'navigation_failed',
];

const SAFE_LABEL = /^[a-z][a-z0-9_-]{0,63}$/i;

export interface PreflightAudioConfig {
  /** Reused verbatim from the G6 probe so the query text and date window stay identical. */
  probe: AccuracyProbeConfig;
  maxLabels: number;
  maxDurationMs: number;
  labelTimeoutMs: number;
}

export interface PreflightAudioLabelResult {
  label: string;
  kind: string;
  outcome: PreflightAudioOutcome;
}

export interface PreflightAudioReport {
  schema_version: 1;
  event: 'preflight_audio_report';
  safety: {
    kafka_enabled: false;
    paid_captcha_enabled: false;
    database_writes: 0;
    kafka_publishes: 0;
    audio_downloaded: false;
    solver_invoked: false;
  };
  labels: {
    planned: number;
    checked: number;
    audio_enabled: string[];
  };
  outcomes: Record<string, number>;
  per_label: PreflightAudioLabelResult[];
  run: {
    elapsed_ms: number;
    stop_reason: 'completed' | 'label_limit' | 'time_limit' | 'shutdown' | 'no_labels';
    /**
     * Advisory only. This never replaces the G6 gate and never changes its
     * thresholds; it only says whether a G6 run could plausibly obtain audio.
     */
    verdict: 'audio_reachable' | 'audio_blocked' | 'inconclusive';
  };
}

function parseInteger(
  raw: string | undefined,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = raw?.trim();
  if (!value) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * The bounds are deliberately tight: this probe exists to be cheap. A sweep of
 * 40 labels at the default per-label timeout still finishes in minutes.
 */
export function loadPreflightAudioConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): PreflightAudioConfig {
  return {
    probe: loadAccuracyProbeConfig(env, now),
    maxLabels: parseInteger(env.PREFLIGHT_MAX_LABELS, 'PREFLIGHT_MAX_LABELS', 20, 1, 40),
    maxDurationMs: parseInteger(
      env.PREFLIGHT_MAX_DURATION_MS,
      'PREFLIGHT_MAX_DURATION_MS',
      600_000,
      10_000,
      1_800_000,
    ),
    labelTimeoutMs: parseInteger(
      env.PREFLIGHT_LABEL_TIMEOUT_MS,
      'PREFLIGHT_LABEL_TIMEOUT_MS',
      45_000,
      5_000,
      120_000,
    ),
  };
}

/** Only opaque catalog labels are reportable; a URL-shaped value must never leak. */
export function selectPreflightLabels(
  entries: ReadonlyArray<{ label: string; kind: string }>,
  config: PreflightAudioConfig,
): PreflightAudioLabelResult[] {
  const requested = config.probe.probeProxyLabels
    ? new Set(config.probe.probeProxyLabels)
    : undefined;
  const seen = new Set<string>();
  const selected: PreflightAudioLabelResult[] = [];
  for (const entry of entries) {
    if (entry.kind === 'rotating') continue;
    if (!SAFE_LABEL.test(entry.label) || seen.has(entry.label)) continue;
    if (requested && !requested.has(entry.label)) continue;
    seen.add(entry.label);
    selected.push({ label: entry.label, kind: entry.kind, outcome: 'navigation_failed' });
    if (selected.length >= config.maxLabels) break;
  }
  return selected;
}

export class PreflightAudioCollector {
  private readonly results: PreflightAudioLabelResult[] = [];

  constructor(private readonly startedAtMs = Date.now()) {}

  record(result: PreflightAudioLabelResult): void {
    if (!SAFE_LABEL.test(result.label)) return;
    this.results.push({ label: result.label, kind: result.kind, outcome: result.outcome });
  }

  checked(): number {
    return this.results.length;
  }

  shouldStop(config: PreflightAudioConfig, nowMs = Date.now()): 'time_limit' | undefined {
    return nowMs - this.startedAtMs >= config.maxDurationMs ? 'time_limit' : undefined;
  }

  report(
    planned: number,
    stopReason: PreflightAudioReport['run']['stop_reason'],
    nowMs = Date.now(),
  ): PreflightAudioReport {
    const outcomes: Record<string, number> = {};
    for (const outcome of PREFLIGHT_AUDIO_OUTCOMES) outcomes[outcome] = 0;
    for (const result of this.results) outcomes[result.outcome] += 1;

    const audioEnabled = this.results
      .filter((result) => result.outcome === 'audio_control_enabled')
      .map((result) => result.label)
      .sort();
    // Three distinct labels is the same proxy-diversity bar G6 applies, so a
    // 'audio_reachable' verdict means a G6 run is not doomed before it starts.
    const sawChallenge = this.results.some(
      (result) => result.outcome !== 'no_captcha' && result.outcome !== 'navigation_failed',
    );

    return {
      schema_version: 1,
      event: 'preflight_audio_report',
      safety: {
        kafka_enabled: false,
        paid_captcha_enabled: false,
        database_writes: 0,
        kafka_publishes: 0,
        audio_downloaded: false,
        solver_invoked: false,
      },
      labels: {
        planned,
        checked: this.results.length,
        audio_enabled: audioEnabled,
      },
      outcomes,
      per_label: this.results.map((result) => ({ ...result })),
      run: {
        elapsed_ms: Math.max(0, nowMs - this.startedAtMs),
        stop_reason: stopReason,
        verdict:
          audioEnabled.length >= 3
            ? 'audio_reachable'
            : sawChallenge && audioEnabled.length === 0
              ? 'audio_blocked'
              : 'inconclusive',
      },
    };
  }
}
