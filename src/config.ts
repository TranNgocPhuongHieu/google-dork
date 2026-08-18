import { GoogleTimeFilter } from './query_builder';
import { DorkJobType } from './payload';
import { DEFAULT_PROFILE, isSearchProfile, SearchProfile } from './profiles';
import { isAbsolute } from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFormat = 'text' | 'json';
export type CaptchaLocalLanguage = 'en-US' | 'vi-VN';

export interface RuntimeConfig {
  timezone: string;
  databaseUrl: string;
  log: {
    level: LogLevel;
    format: LogFormat;
  };
  kafka: {
    enabled: boolean;
    bootstrapServers: string[];
    triggerTopic: string;
    doneTopic: string;
    consumerGroupId: string;
  };
  search: {
    workers: number;
    splitDays: number;
    heartbeatSeconds: number;
    queryDelayMinMs: number;
    queryDelayMaxMs: number;
    pageDelayMinMs: number;
    pageDelayMaxMs: number;
    maxPages: number;
    tierAMaxPages: number;
    tierBMaxPages: number;
    tierCMaxPages: number;
    maxAttempts: number;
    recoveryRotatingRounds: number;
    recoveryWaitMs: number;
    poolWaitMaxMs: number;
  };
  browser: {
    headless: boolean;
    navigationTimeoutMs: number;
    resultWaitTimeoutMs: number;
    locale: string;
  };
  proxy: {
    catalogFile: string;
    blockedCooldownMs: number;
    failureCooldownMs: number;
    successCooldownMs: number;
    rotatingResetTimeoutMs: number;
    rotatingResetWaitMs: number;
  };
  captcha: {
    apiKey: string;
    timeoutMs: number;
    pollMs: number;
    localAudioEnabled: boolean;
    localTimeoutMs: number;
    localMaxAttempts: number;
    localLanguage: CaptchaLocalLanguage;
    voskModelPath: string;
    voskLibraryPath: string;
    ffmpegPath: string;
    workerShutdownMs: number;
  };
  oneShot: {
    searchProfile: SearchProfile;
    sites: string[];
    dateFrom: string;
    dateTo: string;
    keywordIds?: number[];
    timeFilter?: GoogleTimeFilter;
    runType: DorkJobType;
  };
}

const LOG_LEVELS = new Set<LogLevel>(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const LOG_FORMATS = new Set<LogFormat>(['text', 'json']);
const CAPTCHA_LOCAL_LANGUAGES = new Set<CaptchaLocalLanguage>(['en-US', 'vi-VN']);
const JOB_TYPES = new Set<DorkJobType>(['daily', 'backfill', 'manual', 'reconciliation']);
const TIME_FILTERS = new Set<GoogleTimeFilter>([
  'any',
  'past_hour',
  'past_24_hours',
  'past_week',
  'past_month',
  'custom',
]);

function trim(value: string | undefined): string {
  return value?.trim() ?? '';
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  const value = trim(raw).toLowerCase();
  if (!value) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`expected boolean, got "${raw}"`);
}

function parseInteger(
  raw: string | undefined,
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): number {
  const value = trim(raw);
  if (!value) return defaultValue;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer`);
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`${key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${key} must be <= ${options.max}`);
  }
  return parsed;
}

function parseAbsolutePath(raw: string | undefined, key: string, defaultValue: string): string {
  const value = trim(raw) || defaultValue;
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  key: string,
  allowed: Set<T>,
  defaultValue: T,
  normalize: (value: string) => T = (value) => value as T,
): T {
  const value = trim(raw);
  if (!value) return defaultValue;
  const normalized = normalize(value);
  if (!allowed.has(normalized)) {
    throw new Error(`${key} must be one of ${Array.from(allowed).join(', ')}`);
  }
  return normalized;
}

function parseOptionalEnum<T extends string>(
  raw: string | undefined,
  key: string,
  allowed: Set<T>,
  normalize: (value: string) => T = (value) => value as T,
): T | undefined {
  const value = trim(raw);
  if (!value) return undefined;
  const normalized = normalize(value);
  if (!allowed.has(normalized)) {
    throw new Error(`${key} must be one of ${Array.from(allowed).join(', ')}`);
  }
  return normalized;
}

function parseSearchProfile(raw: string | undefined): SearchProfile {
  const value = trim(raw).toLowerCase();
  if (!value) return DEFAULT_PROFILE;
  if (!isSearchProfile(value)) {
    throw new Error(`SEARCH_PROFILE must be a known search profile`);
  }
  return value;
}

function parseCsvList(raw: string | undefined): string[] {
  return trim(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalIntegerCsv(raw: string | undefined, key: string): number[] | undefined {
  const value = trim(raw);
  if (!value) return undefined;

  const out = value.split(',').map((item) => {
    const parsed = Number.parseInt(item.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${key} must contain positive integers only`);
    }
    return parsed;
  });
  return Array.from(new Set(out));
}

function parseBootstrapServers(raw: string | undefined): string[] {
  const servers = parseCsvList(raw);
  return servers.length > 0 ? servers : ['kafka:9092'];
}

function maskUrlCredentials(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const queryDelayMinMs = parseInteger(
    env.SEARCH_QUERY_DELAY_MIN_MS,
    'SEARCH_QUERY_DELAY_MIN_MS',
    30_000,
    { min: 0 },
  );
  const queryDelayMaxMs = parseInteger(
    env.SEARCH_QUERY_DELAY_MAX_MS,
    'SEARCH_QUERY_DELAY_MAX_MS',
    60_000,
    { min: queryDelayMinMs },
  );
  const pageDelayMinMs = parseInteger(
    env.SEARCH_PAGE_DELAY_MIN_MS,
    'SEARCH_PAGE_DELAY_MIN_MS',
    10_000,
    { min: 0 },
  );
  const pageDelayMaxMs = parseInteger(
    env.SEARCH_PAGE_DELAY_MAX_MS,
    'SEARCH_PAGE_DELAY_MAX_MS',
    20_000,
    { min: pageDelayMinMs },
  );
  const maxPages = parseInteger(env.SEARCH_MAX_PAGES, 'SEARCH_MAX_PAGES', 9, {
    min: 1,
    max: 10,
  });

  return {
    timezone: trim(env.TZ) || 'Asia/Ho_Chi_Minh',
    databaseUrl: trim(env.DATABASE_URL),
    log: {
      level: parseEnum(env.LOG_LEVEL, 'LOG_LEVEL', LOG_LEVELS, 'INFO', (value) =>
        value.toUpperCase() as LogLevel,
      ),
      format: parseEnum(env.LOG_FORMAT, 'LOG_FORMAT', LOG_FORMATS, 'text', (value) =>
        value.toLowerCase() as LogFormat,
      ),
    },
    kafka: {
      enabled: parseBoolean(env.KAFKA_ENABLED, false),
      bootstrapServers: parseBootstrapServers(env.KAFKA_BOOTSTRAP_SERVERS),
      triggerTopic: trim(env.KAFKA_TRIGGER_TOPIC) || 'social.dork.trigger',
      doneTopic: trim(env.KAFKA_DONE_TOPIC) || 'social.done',
      consumerGroupId: trim(env.KAFKA_CONSUMER_GROUP_ID) || 'google-dork-playwright-v1',
    },
    search: {
      workers: parseInteger(env.SEARCH_WORKERS, 'SEARCH_WORKERS', 1, { min: 1, max: 1 }),
      splitDays: parseInteger(env.SEARCH_SPLIT_DAYS, 'SEARCH_SPLIT_DAYS', 1, { min: 0 }),
      heartbeatSeconds: parseInteger(env.JOB_HEARTBEAT_SECONDS, 'JOB_HEARTBEAT_SECONDS', 60, {
        min: 10,
      }),
      queryDelayMinMs,
      queryDelayMaxMs,
      pageDelayMinMs,
      pageDelayMaxMs,
      maxPages,
      tierAMaxPages: parseInteger(env.SEARCH_TIER_A_MAX_PAGES, 'SEARCH_TIER_A_MAX_PAGES', 9, {
        min: 1,
        max: maxPages,
      }),
      tierBMaxPages: parseInteger(env.SEARCH_TIER_B_MAX_PAGES, 'SEARCH_TIER_B_MAX_PAGES', 6, {
        min: 1,
        max: maxPages,
      }),
      tierCMaxPages: parseInteger(env.SEARCH_TIER_C_MAX_PAGES, 'SEARCH_TIER_C_MAX_PAGES', 3, {
        min: 1,
        max: maxPages,
      }),
      maxAttempts: parseInteger(env.SEARCH_MAX_ATTEMPTS, 'SEARCH_MAX_ATTEMPTS', 3, {
        min: 1,
        max: 3,
      }),
      recoveryRotatingRounds: parseInteger(
        env.SEARCH_RECOVERY_ROTATING_ROUNDS,
        'SEARCH_RECOVERY_ROTATING_ROUNDS',
        2,
        { min: 0, max: 5 },
      ),
      recoveryWaitMs: parseInteger(
        env.SEARCH_RECOVERY_WAIT_MS,
        'SEARCH_RECOVERY_WAIT_MS',
        30_000,
        { min: 0, max: 300_000 },
      ),
      poolWaitMaxMs: parseInteger(
        env.SEARCH_POOL_WAIT_MAX_MS,
        'SEARCH_POOL_WAIT_MAX_MS',
        20 * 60_000,
        { min: 0 },
      ),
    },
    browser: {
      headless: parseBoolean(env.BROWSER_HEADLESS, true),
      navigationTimeoutMs: parseInteger(
        env.BROWSER_NAVIGATION_TIMEOUT_MS,
        'BROWSER_NAVIGATION_TIMEOUT_MS',
        45_000,
        { min: 5_000 },
      ),
      resultWaitTimeoutMs: parseInteger(
        env.BROWSER_RESULT_WAIT_TIMEOUT_MS,
        'BROWSER_RESULT_WAIT_TIMEOUT_MS',
        15_000,
        { min: 1_000 },
      ),
      locale: trim(env.BROWSER_LOCALE) || 'vi-VN',
    },
    proxy: {
      catalogFile: trim(env.PROXY_CATALOG_FILE) || '/app/proxy.md',
      blockedCooldownMs: parseInteger(
        env.PROXY_BLOCKED_COOLDOWN_MS,
        'PROXY_BLOCKED_COOLDOWN_MS',
        20 * 60_000,
        { min: 1_000 },
      ),
      failureCooldownMs: parseInteger(
        env.PROXY_FAILURE_COOLDOWN_MS,
        'PROXY_FAILURE_COOLDOWN_MS',
        5 * 60_000,
        { min: 1_000 },
      ),
      successCooldownMs: parseInteger(
        env.PROXY_SUCCESS_COOLDOWN_MS,
        'PROXY_SUCCESS_COOLDOWN_MS',
        0,
        { min: 0 },
      ),
      rotatingResetTimeoutMs: parseInteger(
        env.PROXY_ROTATING_RESET_TIMEOUT_MS,
        'PROXY_ROTATING_RESET_TIMEOUT_MS',
        15_000,
        { min: 1_000 },
      ),
      rotatingResetWaitMs: parseInteger(
        env.PROXY_ROTATING_RESET_WAIT_MS,
        'PROXY_ROTATING_RESET_WAIT_MS',
        5_000,
        { min: 0 },
      ),
    },
    captcha: {
      apiKey: trim(env.CAPTCHA_API_KEY),
      timeoutMs: parseInteger(env.CAPTCHA_TIMEOUT_MS, 'CAPTCHA_TIMEOUT_MS', 120_000, {
        min: 10_000,
      }),
      pollMs: parseInteger(env.CAPTCHA_POLL_MS, 'CAPTCHA_POLL_MS', 5_000, {
        min: 1_000,
      }),
      localAudioEnabled: parseBoolean(env.CAPTCHA_LOCAL_AUDIO_ENABLED, false),
      localTimeoutMs: parseInteger(
        env.CAPTCHA_LOCAL_TIMEOUT_MS,
        'CAPTCHA_LOCAL_TIMEOUT_MS',
        60_000,
        { min: 10_000, max: 120_000 },
      ),
      localMaxAttempts: parseInteger(
        env.CAPTCHA_LOCAL_MAX_ATTEMPTS,
        'CAPTCHA_LOCAL_MAX_ATTEMPTS',
        2,
        { min: 1, max: 2 },
      ),
      localLanguage: parseEnum(
        env.CAPTCHA_LOCAL_LANGUAGE,
        'CAPTCHA_LOCAL_LANGUAGE',
        CAPTCHA_LOCAL_LANGUAGES,
        'en-US',
      ),
      voskModelPath: parseAbsolutePath(
        env.CAPTCHA_VOSK_MODEL_PATH,
        'CAPTCHA_VOSK_MODEL_PATH',
        '/opt/models/vosk',
      ),
      voskLibraryPath: parseAbsolutePath(
        env.CAPTCHA_VOSK_LIBRARY_PATH,
        'CAPTCHA_VOSK_LIBRARY_PATH',
        '/opt/vosk/lib/libvosk.so',
      ),
      ffmpegPath: parseAbsolutePath(
        env.CAPTCHA_FFMPEG_PATH,
        'CAPTCHA_FFMPEG_PATH',
        '/usr/bin/ffmpeg',
      ),
      workerShutdownMs: parseInteger(
        env.CAPTCHA_WORKER_SHUTDOWN_MS,
        'CAPTCHA_WORKER_SHUTDOWN_MS',
        3_000,
        { min: 500, max: 10_000 },
      ),
    },
    oneShot: {
      searchProfile: parseSearchProfile(env.SEARCH_PROFILE),
      sites: parseCsvList(env.SEARCH_SITES),
      dateFrom: trim(env.SEARCH_DATE_FROM),
      dateTo: trim(env.SEARCH_DATE_TO),
      keywordIds: parseOptionalIntegerCsv(env.SEARCH_KEYWORD_IDS, 'SEARCH_KEYWORD_IDS'),
      timeFilter: parseOptionalEnum(
        env.SEARCH_TIME_FILTER,
        'SEARCH_TIME_FILTER',
        TIME_FILTERS,
        (value) => value.toLowerCase() as GoogleTimeFilter,
      ),
      runType: parseEnum(env.RUN_TYPE, 'RUN_TYPE', JOB_TYPES, 'daily', (value) =>
        value.toLowerCase() as DorkJobType,
      ),
    },
  };
}

export const config = loadConfig();

export function describeConfig(cfg: RuntimeConfig = config): Record<string, unknown> {
  return {
    timezone: cfg.timezone,
    database_url: cfg.databaseUrl ? maskUrlCredentials(cfg.databaseUrl) : '[unset]',
    log: cfg.log,
    kafka: {
      enabled: cfg.kafka.enabled,
      bootstrap_servers: cfg.kafka.bootstrapServers,
      trigger_topic: cfg.kafka.triggerTopic,
      done_topic: cfg.kafka.doneTopic,
      consumer_group_id: cfg.kafka.consumerGroupId,
    },
    search: cfg.search,
    browser: cfg.browser,
    proxy: {
      catalog_file: cfg.proxy.catalogFile,
      blocked_cooldown_ms: cfg.proxy.blockedCooldownMs,
      failure_cooldown_ms: cfg.proxy.failureCooldownMs,
      success_cooldown_ms: cfg.proxy.successCooldownMs,
      rotating_reset_wait_ms: cfg.proxy.rotatingResetWaitMs,
    },
    captcha: {
      paid_enabled: Boolean(cfg.captcha.apiKey),
      timeout_ms: cfg.captcha.timeoutMs,
      poll_ms: cfg.captcha.pollMs,
      local_audio_enabled: cfg.captcha.localAudioEnabled,
      local_timeout_ms: cfg.captcha.localTimeoutMs,
      local_max_attempts: cfg.captcha.localMaxAttempts,
      local_language: cfg.captcha.localLanguage,
      vosk_model_path: cfg.captcha.voskModelPath,
      vosk_library_path: cfg.captcha.voskLibraryPath,
      ffmpeg_path: cfg.captcha.ffmpegPath,
      worker_shutdown_ms: cfg.captcha.workerShutdownMs,
    },
    one_shot: {
      search_profile: cfg.oneShot.searchProfile,
      sites: cfg.oneShot.sites,
      date_from: cfg.oneShot.dateFrom || '[unset]',
      date_to: cfg.oneShot.dateTo || '[unset]',
      keyword_ids: cfg.oneShot.keywordIds ?? [],
      time_filter: cfg.oneShot.timeFilter ?? '[unset]',
      run_type: cfg.oneShot.runType,
    },
  };
}
