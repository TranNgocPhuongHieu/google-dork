import { REGISTRY } from './entity_registry';
import { buildSiteSearchTexts, normalizeSite } from './platforms';
import { DEFAULT_PROFILE, isSearchProfile, SearchProfile } from './profiles';
import { buildQueries, GoogleTimeFilter } from './query_builder';

const ALLOWED_SITES = new Set(['facebook.com', 'instagram.com', 'tiktok.com']);

/**
 * Failures that happen BEFORE any audio reaches the solver. The local solver is
 * never invoked for these, so they must not be counted as solver failures — a
 * blocked proxy would otherwise look like a broken transcription pipeline.
 */
export const CAPTURE_FAILURE_REASONS = new Set([
  'challenge_unavailable',
  'audio_unavailable',
  'audio_payload_unavailable',
  'audio_control_unavailable',
  'audio_control_not_visible',
  'audio_control_disabled',
  'audio_control_click_failed',
  'audio_response_timeout',
  'audio_response_http_error',
  'audio_payload_too_large',
  'audio_payload_body_unavailable',
  'proxy_blocked',
]);

/** Failures that happen AFTER audio was handed to the solver. */
export const SOLVE_FAILURE_REASONS = new Set([
  'answer_controls_unavailable',
  'answer_fill_failed',
  'answer_verify_click_failed',
  'answer_verification_timeout',
  'answer_verification_http_error',
  'answer_verification_unsolved',
  'transcription_failed',
  'timeout',
  'verification_failed',
]);

const LOCAL_RESULT_STATUSES = new Set([
  'solved',
  ...CAPTURE_FAILURE_REASONS,
  ...SOLVE_FAILURE_REASONS,
]);
const SAFE_LABEL = /^[a-z][a-z0-9_-]{0,63}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ProbeCaptchaEventName =
  | 'captcha_audio_offered'
  | 'captcha_local_attempt'
  | 'captcha_local_result'
  | 'captcha_paid_fallback'
  | 'captcha_hard_block';

/** This is intentionally restricted to fields that are safe to report from a live canary. */
export interface ProbeCaptchaEvent {
  event: ProbeCaptchaEventName;
  proxyLabel?: string;
  status?: string;
  reasonCode?: string;
  durationMs?: number;
  /**
   * Where the failure occurred. 'capture' means no audio ever reached the
   * solver. Absent values are classified from the reason code so older event
   * producers keep reporting correctly.
   */
  stage?: 'capture' | 'solve';
}

export interface AccuracyProbeConfig {
  confirmLive: boolean;
  localCaptchaEnabled: boolean;
  profile: SearchProfile;
  sites: string[];
  slugs: string[];
  dateFrom: string;
  dateTo: string;
  maxQueries: number;
  maxDurationMs: number;
  targetAudioChallenges: number;
  /** Optional G6-only subset expressed as opaque catalog labels. */
  probeProxyLabels?: string[];
}

export interface AccuracyProbeQuery {
  id: string;
  query: string;
  site: string;
  maxPages: 1;
  timeFilter: GoogleTimeFilter;
}

export interface AccuracyProbeMetrics {
  schema_version: 2;
  safety: {
    kafka_enabled: false;
    paid_captcha_enabled: false;
    local_captcha_enabled: boolean;
    database_writes: 0;
    kafka_publishes: 0;
  };
  query: {
    planned: number;
    started: number;
    completed: number;
    succeeded: number;
    failed: number;
    blocked: number;
    organic_results: number;
    eligible_results: number;
  };
  captcha: {
    audio_offered: number;
    local_attempted: number;
    local_solved: number;
    local_failed: number;
    /**
     * Failures before the solver ran (blocked/disabled audio control, timeouts).
     * Counted separately so `local_failed` stays comparable to `local_attempted`.
     */
    capture_failed: number;
    local_duration_ms: {
      count: number;
      p50: number | null;
      p95: number | null;
    };
    /** All outcome reason codes, capture and solve stages combined. */
    outcomes: Record<string, number>;
    /** Reason codes for failures that never reached the solver. */
    capture_outcomes: Record<string, number>;
    /** Labels that actually produced a downloadable audio challenge. */
    audio_proxy_labels: string[];
    proxy_labels: string[];
    paid_fallback_events: number;
    hard_block_events: number;
  };
  process: {
    rss_start_bytes: number;
    rss_end_bytes: number;
    rss_delta_bytes: number;
    cleanup: {
      worker_restarts: number;
      circuit_open: boolean;
      active_children: number;
      pending_requests: number;
      active_temp_dirs: number;
    };
  };
  run: {
    elapsed_ms: number;
    stop_reason: 'target_reached' | 'query_limit' | 'time_limit' | 'no_queries' | 'shutdown';
    local_success_rate: number | null;
    local_p95_within_60000ms: boolean | null;
    gate: 'ready_for_review' | 'inconclusive' | 'failed';
  };
}

function parseBoolean(raw: string | undefined, key: string, defaultValue: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} must be true or false`);
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

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  const values = (raw?.trim() ? raw : fallback.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function parseProbeProxyLabels(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const labels = raw.split(',').map((item) => item.trim());
  if (
    labels.length < 3 ||
    labels.length > 20 ||
    labels.some((label) => !SAFE_LABEL.test(label)) ||
    new Set(labels).size !== labels.length
  ) {
    throw new Error('PROBE_PROXY_LABELS must contain 3 to 20 unique safe proxy labels');
  }
  return labels;
}

function assertDate(value: string, key: string): void {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${key} must use YYYY-MM-DD`);
  }
}

function parseProbeProfile(raw: string | undefined): SearchProfile {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_PROFILE;
  if (!isSearchProfile(value)) {
    throw new Error('PROBE_PROFILE must contain a known search profile');
  }
  return value;
}

export function loadAccuracyProbeConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AccuracyProbeConfig {
  const today = now.toISOString().slice(0, 10);
  const sites = parseCsv(env.SEARCH_SITES, ['facebook.com', 'instagram.com', 'tiktok.com']).map(
    normalizeSite,
  );
  if (sites.length === 0 || sites.some((site) => !ALLOWED_SITES.has(site))) {
    throw new Error('SEARCH_SITES must contain only facebook.com, instagram.com, tiktok.com');
  }

  const slugs = parseCsv(env.SLUGS, ['da_nang']);
  if (slugs.length === 0 || slugs.some((slug) => !REGISTRY[slug])) {
    throw new Error('SLUGS must contain known province slugs only');
  }

  const dateFrom = env.SEARCH_DATE_FROM?.trim() || today;
  const dateTo = env.SEARCH_DATE_TO?.trim() || dateFrom;
  assertDate(dateFrom, 'SEARCH_DATE_FROM');
  assertDate(dateTo, 'SEARCH_DATE_TO');
  if (dateFrom > dateTo)
    throw new Error('SEARCH_DATE_TO must be greater than or equal to SEARCH_DATE_FROM');

  return {
    confirmLive: parseBoolean(env.PROBE_CONFIRM_LIVE, 'PROBE_CONFIRM_LIVE', false),
    localCaptchaEnabled: parseBoolean(
      env.CAPTCHA_LOCAL_AUDIO_ENABLED,
      'CAPTCHA_LOCAL_AUDIO_ENABLED',
      false,
    ),
    profile: parseProbeProfile(env.PROBE_PROFILE),
    sites,
    slugs,
    dateFrom,
    dateTo,
    maxQueries: parseInteger(env.PROBE_MAX_QUERIES, 'PROBE_MAX_QUERIES', 100, 1, 100),
    maxDurationMs: parseInteger(
      env.PROBE_MAX_DURATION_MS,
      'PROBE_MAX_DURATION_MS',
      7_200_000,
      1_000,
      7_200_000,
    ),
    targetAudioChallenges: parseInteger(
      env.PROBE_TARGET_AUDIO_CHALLENGES,
      'PROBE_TARGET_AUDIO_CHALLENGES',
      20,
      20,
      100,
    ),
    probeProxyLabels: parseProbeProxyLabels(env.PROBE_PROXY_LABELS),
  };
}

/**
 * Prevent an inherited daemon environment from enabling Kafka or a paid solver
 * in the probe process. The local solver stays off unless explicitly set true.
 */
export function applyAccuracyProbeSafetyGuards(env: NodeJS.ProcessEnv = process.env): void {
  env.KAFKA_ENABLED = 'false';
  env.CAPTCHA_API_KEY = '';
  env.SEARCH_WORKERS = '1';
  env.SEARCH_MAX_PAGES = '1';
  // The normal daemon tiers may be larger; keep them consistent with the probe page cap.
  env.SEARCH_TIER_A_MAX_PAGES = '1';
  env.SEARCH_TIER_B_MAX_PAGES = '1';
  env.SEARCH_TIER_C_MAX_PAGES = '1';
  // A probe-only pool excludes rotating entries, so recovery rounds could only
  // consume the bounded canary window without making another request.
  env.SEARCH_RECOVERY_ROTATING_ROUNDS = '0';
  env.SEARCH_RECOVERY_WAIT_MS = '0';
  env.CAPTCHA_LOCAL_AUDIO_ENABLED = parseBoolean(
    env.CAPTCHA_LOCAL_AUDIO_ENABLED,
    'CAPTCHA_LOCAL_AUDIO_ENABLED',
    false,
  )
    ? 'true'
    : 'false';
}

export function buildAccuracyProbeQueries(config: AccuracyProbeConfig): AccuracyProbeQuery[] {
  const queries: AccuracyProbeQuery[] = [];
  for (const slug of config.slugs) {
    for (const site of config.sites) {
      const searchTexts = buildSiteSearchTexts(site, slug, config.profile);
      for (const searchText of searchTexts) {
        if (!searchText) continue;
        const built = buildQueries(
          [site],
          searchText,
          config.dateFrom,
          config.dateTo,
          1,
          'custom',
          'bounded',
        );
        for (const query of built) {
          queries.push({
            id: `probe-${queries.length + 1}`,
            query: query.query,
            site: query.site,
            maxPages: 1,
            timeFilter: 'custom',
          });
          if (queries.length >= config.maxQueries) return queries;
        }
      }
    }
  }
  return queries;
}

function safeLabel(value: string | undefined): string | undefined {
  return value && SAFE_LABEL.test(value) ? value : undefined;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export class AccuracyProbeCollector {
  private readonly durations: number[] = [];
  private readonly proxyLabels = new Set<string>();
  private readonly audioProxyLabels = new Set<string>();
  private readonly outcomes: Record<string, number> = {};
  private readonly captureOutcomes: Record<string, number> = {};
  private audioOffered = 0;
  private localAttempted = 0;
  private localSolved = 0;
  private localFailed = 0;
  private captureFailed = 0;
  private paidFallbackEvents = 0;
  private hardBlockEvents = 0;
  private organicResults = 0;
  private eligibleResults = 0;
  private queriesStarted = 0;
  private queriesCompleted = 0;
  private queriesSucceeded = 0;
  private queriesFailed = 0;
  private queriesBlocked = 0;

  constructor(
    private readonly startedAtMs = Date.now(),
    private readonly rssStartBytes = process.memoryUsage().rss,
  ) {}

  recordCaptchaEvent(event: ProbeCaptchaEvent): void {
    const label = safeLabel(event.proxyLabel);
    if (label) this.proxyLabels.add(label);

    if (event.event === 'captcha_audio_offered') {
      this.audioOffered += 1;
      if (label) this.audioProxyLabels.add(label);
    }
    if (event.event === 'captcha_local_attempt') this.localAttempted += 1;
    if (event.event === 'captcha_paid_fallback') this.paidFallbackEvents += 1;
    if (event.event === 'captcha_hard_block') this.hardBlockEvents += 1;
    if (event.event === 'captcha_local_result') {
      const reasonCode = event.reasonCode ?? '';
      const solved = event.status === 'success' || event.status === 'solved';
      const status = solved
        ? 'solved'
        : LOCAL_RESULT_STATUSES.has(event.status ?? '')
          ? event.status!
          : LOCAL_RESULT_STATUSES.has(reasonCode)
            ? reasonCode
            : 'unknown';
      this.outcomes[status] = (this.outcomes[status] ?? 0) + 1;

      if (solved) {
        this.localSolved += 1;
      } else if (this.isCaptureStage(event, status)) {
        // No audio ever reached the solver, so this is not a solver failure.
        this.captureFailed += 1;
        this.captureOutcomes[status] = (this.captureOutcomes[status] ?? 0) + 1;
      } else {
        this.localFailed += 1;
      }

      // A duration is only meaningful when the solver actually ran.
      if (
        (solved || !this.isCaptureStage(event, status)) &&
        Number.isSafeInteger(event.durationMs) &&
        event.durationMs! >= 0
      ) {
        this.durations.push(event.durationMs!);
      }
    }
  }

  /**
   * An explicit stage wins. Otherwise classify from the reason code, which keeps
   * event producers that predate the stage field reporting correctly.
   */
  private isCaptureStage(event: ProbeCaptchaEvent, status: string): boolean {
    if (event.stage) return event.stage === 'capture';
    if (CAPTURE_FAILURE_REASONS.has(status)) return true;
    // Solve-stage codes and unrecognized codes both count against the solver.
    // Attributing an unknown failure to the solver is the conservative choice:
    // it lowers the success rate rather than hiding a real defect.
    return false;
  }

  recordQueryStarted(): void {
    this.queriesStarted += 1;
  }

  recordQueryCompleted(input: {
    succeeded: boolean;
    blocked: boolean;
    organicResults: number;
    eligibleResults: number;
  }): void {
    this.queriesCompleted += 1;
    if (input.succeeded) this.queriesSucceeded += 1;
    if (input.blocked) this.queriesBlocked += 1;
    if (!input.succeeded && !input.blocked) this.queriesFailed += 1;
    this.organicResults += input.organicResults;
    this.eligibleResults += input.eligibleResults;
  }

  shouldStop(
    config: AccuracyProbeConfig,
    nowMs = Date.now(),
  ): 'target_reached' | 'time_limit' | undefined {
    if (this.audioOffered >= config.targetAudioChallenges) return 'target_reached';
    if (nowMs - this.startedAtMs >= config.maxDurationMs) return 'time_limit';
    return undefined;
  }

  report(
    config: AccuracyProbeConfig,
    planned: number,
    stopReason: AccuracyProbeMetrics['run']['stop_reason'],
    nowMs = Date.now(),
    cleanup: AccuracyProbeMetrics['process']['cleanup'] = {
      worker_restarts: 0,
      circuit_open: false,
      active_children: 0,
      pending_requests: 0,
      active_temp_dirs: 0,
    },
  ): AccuracyProbeMetrics {
    const p50 = percentile(this.durations, 0.5);
    const p95 = percentile(this.durations, 0.95);
    const localSuccessRate = this.audioOffered > 0 ? this.localSolved / this.audioOffered : null;
    const failedSafety = this.paidFallbackEvents > 0;
    const enoughAudio = this.audioOffered >= config.targetAudioChallenges;
    const enoughProxies = this.audioProxyLabels.size >= 3;
    const localLatencyPass = p95 !== null && p95 <= 60_000;
    const cleanShutdown =
      cleanup.active_children === 0 && cleanup.pending_requests === 0 && cleanup.active_temp_dirs === 0;

    return {
      schema_version: 2,
      safety: {
        kafka_enabled: false,
        paid_captcha_enabled: false,
        local_captcha_enabled: config.localCaptchaEnabled,
        database_writes: 0,
        kafka_publishes: 0,
      },
      query: {
        planned,
        started: this.queriesStarted,
        completed: this.queriesCompleted,
        succeeded: this.queriesSucceeded,
        failed: this.queriesFailed,
        blocked: this.queriesBlocked,
        organic_results: this.organicResults,
        eligible_results: this.eligibleResults,
      },
      captcha: {
        audio_offered: this.audioOffered,
        local_attempted: this.localAttempted,
        local_solved: this.localSolved,
        local_failed: this.localFailed,
        capture_failed: this.captureFailed,
        local_duration_ms: { count: this.durations.length, p50, p95 },
        outcomes: { ...this.outcomes },
        capture_outcomes: { ...this.captureOutcomes },
        audio_proxy_labels: Array.from(this.audioProxyLabels).sort(),
        proxy_labels: Array.from(this.proxyLabels).sort(),
        paid_fallback_events: this.paidFallbackEvents,
        hard_block_events: this.hardBlockEvents,
      },
      process: {
        rss_start_bytes: this.rssStartBytes,
        rss_end_bytes: process.memoryUsage().rss,
        rss_delta_bytes: process.memoryUsage().rss - this.rssStartBytes,
        cleanup,
      },
      run: {
        elapsed_ms: Math.max(0, nowMs - this.startedAtMs),
        stop_reason: stopReason,
        local_success_rate: localSuccessRate,
        local_p95_within_60000ms: p95 === null ? null : p95 <= 60_000,
        gate:
          !cleanShutdown ||
          failedSafety ||
          (enoughAudio && enoughProxies && localSuccessRate !== null && localSuccessRate < 0.6) ||
          (enoughAudio && enoughProxies && !localLatencyPass)
            ? 'failed'
            : enoughAudio && enoughProxies && config.localCaptchaEnabled
              ? 'ready_for_review'
              : 'inconclusive',
      },
    };
  }
}
