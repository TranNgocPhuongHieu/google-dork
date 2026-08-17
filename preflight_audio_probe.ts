// Cheap pre-flight for the G6 audio path. It navigates once per proxy label and
// only LOOKS at the reCAPTCHA audio control: no audio is requested, no solver is
// constructed, nothing is written to Postgres or Kafka. It is advisory input for
// deciding whether a full G6 canary is worth running — it never replaces the G6
// gate and never changes a G6 threshold.
import 'dotenv/config';

import {
  applyAccuracyProbeSafetyGuards,
  buildAccuracyProbeQueries,
  loadAccuracyProbeConfig,
} from './src/accuracy_probe';
import {
  loadPreflightAudioConfig,
  PreflightAudioCollector,
  PreflightAudioConfig,
  PreflightAudioOutcome,
  PreflightAudioReport,
  selectPreflightLabels,
} from './src/preflight_audio';
import { createProbeCancellation, probeDelayMs, waitForAbortableProbeDelay } from './accuracy_probe';

type PreflightFailureCode =
  | 'invalid_preflight_config'
  | 'live_confirmation_required'
  | 'crawler_module_import_failed'
  | 'proxy_load_failed'
  | 'no_queries'
  | 'preflight_failed';

type PreflightPhase =
  | 'configuration'
  | 'safety_guards'
  | 'query_build'
  | 'crawler_import'
  | 'proxy_load'
  | 'label_sweep'
  | 'cleanup'
  | 'report';

let activePhase: PreflightPhase = 'configuration';

class PreflightFailure extends Error {
  constructor(
    readonly code: PreflightFailureCode,
    readonly phase: PreflightPhase,
  ) {
    super(code);
  }
}

/** Never echo a dependency error: it can contain a proxy URL or credentials. */
function reportFailure(code: PreflightFailureCode, phase: PreflightPhase): void {
  console.error(JSON.stringify({ event: 'preflight_audio_failed', code, phase }));
}

type CrawlerModule = typeof import('./src/google_crawler');

/**
 * One navigation, one look at the audio control. Every failure path collapses to
 * an opaque outcome code so no proxy URL, sitekey or page text can escape.
 */
async function checkLabel(
  crawler: CrawlerModule,
  proxy: import('./src/proxy_pool').ProxyEntry,
  query: import('./src/accuracy_probe').AccuracyProbeQuery,
  config: PreflightAudioConfig,
): Promise<PreflightAudioOutcome> {
  const context = await crawler.createContext(proxy);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(config.labelTimeoutMs);
    const response = await page
      .goto(crawler.buildGoogleSearchUrl(query, 0), {
        waitUntil: 'domcontentloaded',
        timeout: config.labelTimeoutMs,
      })
      .catch(() => undefined);
    if (!response) return 'navigation_failed';

    await crawler.acceptConsent(page).catch(() => {});
    if (!(await crawler.isCaptchaPage(page).catch(() => false))) return 'no_captcha';
    if (await crawler.isHardCaptchaBlock(page).catch(() => false)) return 'hard_block';

    // Activating the checkbox is required before a bframe exists. This still
    // requests no audio: the audio button is inspected, never clicked.
    const challengeFrame = await crawler.openRecaptchaAudioChallenge(page).catch(() => undefined);
    if (!challengeFrame) return 'challenge_unavailable';
    return crawler.inspectRecaptchaAudioControl(challengeFrame);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  activePhase = 'configuration';
  let config: PreflightAudioConfig;
  try {
    config = loadPreflightAudioConfig();
  } catch {
    throw new PreflightFailure('invalid_preflight_config', activePhase);
  }
  if (!config.probe.confirmLive) {
    throw new PreflightFailure('live_confirmation_required', activePhase);
  }

  activePhase = 'safety_guards';
  applyAccuracyProbeSafetyGuards();
  // The solver is irrelevant here and must never be constructed, so keep the
  // local audio path off regardless of the inherited environment.
  process.env.CAPTCHA_LOCAL_AUDIO_ENABLED = 'false';
  config = { ...config, probe: loadAccuracyProbeConfig() };

  activePhase = 'query_build';
  const queries = buildAccuracyProbeQueries(config.probe);
  if (queries.length === 0) throw new PreflightFailure('no_queries', activePhase);

  activePhase = 'crawler_import';
  let crawler: CrawlerModule;
  try {
    // Imported after the guards above because these modules read config at import time.
    crawler = await import('./src/google_crawler');
  } catch {
    throw new PreflightFailure('crawler_module_import_failed', activePhase);
  }
  const { config: runtimeConfig } = await import('./src/config');

  activePhase = 'proxy_load';
  let pool: import('./src/proxy_pool').ProxyPool;
  try {
    const { loadProxyPool } = await import('./src/proxy_pool');
    pool = await loadProxyPool();
  } catch {
    throw new PreflightFailure('proxy_load_failed', activePhase);
  }

  const planned = selectPreflightLabels(
    pool.snapshot().map((row) => ({ label: String(row.proxy), kind: String(row.kind) })),
    config,
  );
  const collector = new PreflightAudioCollector();
  const cancellation = createProbeCancellation(config.maxDurationMs);
  let stopReason: PreflightAudioReport['run']['stop_reason'] =
    planned.length === 0 ? 'no_labels' : 'completed';

  try {
    activePhase = 'label_sweep';
    for (let index = 0; index < planned.length; index++) {
      if (cancellation.signal.aborted) {
        stopReason = cancellation.stopReason();
        break;
      }
      const timeLimited = collector.shouldStop(config);
      if (timeLimited) {
        stopReason = timeLimited;
        break;
      }
      if (index > 0) {
        const completed = await waitForAbortableProbeDelay(
          probeDelayMs(runtimeConfig.search.queryDelayMinMs, runtimeConfig.search.queryDelayMaxMs),
          cancellation.signal,
        );
        if (!completed) {
          stopReason = cancellation.stopReason();
          break;
        }
      }

      const label = planned[index].label;
      // A single-label sub-pool keeps the catalog-backed pool's counters untouched.
      const proxy = pool.selectProbeLabels([label]).acquirePrimary();
      const outcome = proxy
        ? await checkLabel(crawler, proxy, queries[index % queries.length], config).catch(
            (): PreflightAudioOutcome => 'navigation_failed',
          )
        : 'navigation_failed';
      collector.record({ ...planned[index], outcome });
    }
    if (stopReason === 'completed' && collector.checked() < planned.length) {
      stopReason = 'label_limit';
    }
  } finally {
    activePhase = 'cleanup';
    cancellation.dispose();
    await crawler.closeGoogleCrawler().catch(() => {});
  }

  activePhase = 'report';
  console.log(JSON.stringify(collector.report(planned.length, stopReason, Date.now())));
}

if (require.main === module) {
  main().catch((error) => {
    reportFailure(
      error instanceof PreflightFailure ? error.code : 'preflight_failed',
      error instanceof PreflightFailure ? error.phase : activePhase,
    );
    process.exitCode = 1;
  });
}
