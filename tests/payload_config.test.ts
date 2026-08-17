import test from 'node:test';
import assert from 'node:assert/strict';

import { describeConfig, loadConfig } from '../src/config';
import { parseDorkTriggerPayload } from '../src/payload';

test('loadConfig parses validated runtime settings from env', () => {
  const cfg = loadConfig({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/social_scraper',
    KAFKA_ENABLED: 'true',
    KAFKA_BOOTSTRAP_SERVERS: 'kafka-1:9092,kafka-2:9092',
    LOG_LEVEL: 'debug',
    LOG_FORMAT: 'json',
    SEARCH_WORKERS: '1',
    SEARCH_SPLIT_DAYS: '2',
    JOB_HEARTBEAT_SECONDS: '45',
    SEARCH_QUERY_DELAY_MIN_MS: '30000',
    SEARCH_QUERY_DELAY_MAX_MS: '60000',
    SEARCH_PAGE_DELAY_MIN_MS: '10000',
    SEARCH_PAGE_DELAY_MAX_MS: '20000',
    SEARCH_MAX_PAGES: '9',
    SEARCH_TIER_A_MAX_PAGES: '9',
    SEARCH_TIER_B_MAX_PAGES: '6',
    SEARCH_TIER_C_MAX_PAGES: '3',
    SEARCH_SITES: 'facebook.com,x.com',
    SEARCH_DATE_FROM: '2026-03-01',
    SEARCH_DATE_TO: '2026-03-02',
    SEARCH_KEYWORD_IDS: '1,2,2',
    SEARCH_TIME_FILTER: 'custom',
    RUN_TYPE: 'manual',
    PROXY_CATALOG_FILE: '/tmp/proxy.md',
    CAPTCHA_API_KEY: 'secret',
    CAPTCHA_LOCAL_AUDIO_ENABLED: 'true',
    CAPTCHA_LOCAL_TIMEOUT_MS: '61000',
    CAPTCHA_LOCAL_MAX_ATTEMPTS: '1',
    CAPTCHA_LOCAL_LANGUAGE: 'vi-VN',
    CAPTCHA_VOSK_MODEL_PATH: '/models/vosk-vi',
    CAPTCHA_VOSK_LIBRARY_PATH: '/libs/libvosk.so',
    CAPTCHA_FFMPEG_PATH: '/usr/local/bin/ffmpeg',
    CAPTCHA_WORKER_SHUTDOWN_MS: '3500',
    KAFKA_CONSUMER_GROUP_ID: 'google-dork-playwright-v1',
  });

  assert.equal(cfg.log.level, 'DEBUG');
  assert.equal(cfg.log.format, 'json');
  assert.equal(cfg.kafka.enabled, true);
  assert.deepEqual(cfg.kafka.bootstrapServers, ['kafka-1:9092', 'kafka-2:9092']);
  assert.equal(cfg.search.workers, 1);
  assert.equal(cfg.search.queryDelayMinMs, 30000);
  assert.equal(cfg.search.queryDelayMaxMs, 60000);
  assert.equal(cfg.search.pageDelayMinMs, 10000);
  assert.equal(cfg.search.pageDelayMaxMs, 20000);
  assert.equal(cfg.search.maxPages, 9);
  assert.equal(cfg.search.tierAMaxPages, 9);
  assert.equal(cfg.search.tierBMaxPages, 6);
  assert.equal(cfg.search.tierCMaxPages, 3);
  assert.equal(cfg.proxy.catalogFile, '/tmp/proxy.md');
  assert.equal(cfg.captcha.apiKey, 'secret');
  assert.equal(cfg.captcha.localAudioEnabled, true);
  assert.equal(cfg.captcha.localTimeoutMs, 61_000);
  assert.equal(cfg.captcha.localMaxAttempts, 1);
  assert.equal(cfg.captcha.localLanguage, 'vi-VN');
  assert.equal(cfg.captcha.voskModelPath, '/models/vosk-vi');
  assert.equal(cfg.captcha.voskLibraryPath, '/libs/libvosk.so');
  assert.equal(cfg.captcha.ffmpegPath, '/usr/local/bin/ffmpeg');
  assert.equal(cfg.captcha.workerShutdownMs, 3_500);
  assert.equal(cfg.kafka.consumerGroupId, 'google-dork-playwright-v1');
  assert.deepEqual(cfg.oneShot.keywordIds, [1, 2]);
  assert.equal(cfg.oneShot.runType, 'manual');
  assert.equal(cfg.oneShot.timeFilter, 'custom');
});

test('local captcha defaults are disabled and config output does not expose the API key', () => {
  const cfg = loadConfig({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/social_scraper',
    CAPTCHA_API_KEY: 'not-for-logs',
  });

  assert.equal(cfg.captcha.localAudioEnabled, false);
  assert.equal(cfg.captcha.localTimeoutMs, 60_000);
  assert.equal(cfg.captcha.localMaxAttempts, 2);
  assert.equal(cfg.captcha.localLanguage, 'en-US');
  assert.equal(cfg.captcha.voskModelPath, '/opt/models/vosk');
  assert.equal(cfg.captcha.voskLibraryPath, '/opt/vosk/lib/libvosk.so');
  assert.equal(cfg.captcha.ffmpegPath, '/usr/bin/ffmpeg');
  assert.equal(cfg.captcha.workerShutdownMs, 3_000);

  const described = JSON.stringify(describeConfig(cfg));
  assert.match(described, /paid_enabled/);
  assert.doesNotMatch(described, /not-for-logs/);
});

test('local captcha config rejects invalid values and relative paths', () => {
  const env = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/social_scraper' };

  assert.throws(() => loadConfig({ ...env, CAPTCHA_LOCAL_AUDIO_ENABLED: 'yes' }), /expected boolean/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_LOCAL_TIMEOUT_MS: '9999' }), /must be >= 10000/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_LOCAL_MAX_ATTEMPTS: '3' }), /must be <= 2/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_LOCAL_LANGUAGE: 'fr-FR' }), /must be one of/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_VOSK_MODEL_PATH: 'models/vosk' }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_VOSK_LIBRARY_PATH: 'libvosk.so' }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_FFMPEG_PATH: 'ffmpeg' }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, CAPTCHA_WORKER_SHUTDOWN_MS: '100' }), /must be >= 500/);
});

test('parseDorkTriggerPayload validates and normalizes payload', () => {
  const payload = parseDorkTriggerPayload({
    job_id: 'job-1',
    job_type: 'daily',
    search_sites: ['facebook', 'x.com', 'facebook.com'],
    date_from: '2026-03-01',
    date_to: '2026-03-02',
    keyword_ids: [1, 2, 2],
    split_days: 3,
    max_pages: 3,
    time_filter: 'custom',
  });

  assert.deepEqual(payload.search_sites, ['facebook.com', 'x.com']);
  assert.deepEqual(payload.keyword_ids, [1, 2]);
  assert.equal(payload.time_filter, 'custom');
  assert.equal(payload.max_pages, 3);
});

test('parseDorkTriggerPayload rejects invalid date order', () => {
  assert.throws(
    () => parseDorkTriggerPayload({
      job_id: 'job-1',
      job_type: 'daily',
      search_sites: ['facebook.com'],
      date_from: '2026-03-03',
      date_to: '2026-03-01',
    }),
    /date_to must be greater than or equal to date_from/,
  );
});
