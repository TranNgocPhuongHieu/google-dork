// G6 shadow canary entry point. It deliberately never imports main.ts or src/db.ts.
import 'dotenv/config';

import {
  AccuracyProbeCollector,
  AccuracyProbeConfig,
  applyAccuracyProbeSafetyGuards,
  buildAccuracyProbeQueries,
  loadAccuracyProbeConfig,
  ProbeCaptchaEvent,
} from './src/accuracy_probe';
import { extractPostId, isEligiblePostUrl, isLikelyAdResult } from './src/platforms';

type ProbeFailureCode =
  | 'invalid_probe_config'
  | 'live_confirmation_required'
  | 'local_captcha_required'
  | 'captcha_module_import_failed'
  | 'crawler_module_import_failed'
  | 'proxy_selection_failed'
  | 'probe_failed';

type ProbePhase =
  | 'configuration'
  | 'safety_guards'
  | 'query_build'
  | 'crawler_import'
  | 'crawler_execution'
  | 'cleanup'
  | 'report';

type ProbeStopReason = 'target_reached' | 'query_limit' | 'time_limit' | 'no_queries' | 'shutdown';

export interface ProbeCancellation {
  signal: AbortSignal;
  requestShutdown: () => void;
  stopReason: () => 'time_limit' | 'shutdown';
  dispose: () => void;
}

/** Shares deadline and container-signal cancellation with browser and Vosk work. */
export function createProbeCancellation(maxDurationMs: number): ProbeCancellation {
  const controller = new AbortController();
  let reason: 'time_limit' | 'shutdown' = 'time_limit';
  const timeout = setTimeout(() => controller.abort(), maxDurationMs);
  timeout.unref();
  const requestShutdown = () => {
    if (controller.signal.aborted) return;
    reason = 'shutdown';
    controller.abort();
  };
  process.once('SIGTERM', requestShutdown);
  process.once('SIGINT', requestShutdown);
  return {
    signal: controller.signal,
    requestShutdown,
    stopReason: () => reason,
    dispose: () => {
      clearTimeout(timeout);
      process.off('SIGTERM', requestShutdown);
      process.off('SIGINT', requestShutdown);
    },
  };
}

export function probeDelayMs(minMs: number, maxMs: number, random = Math.random): number {
  if (maxMs <= minMs) return minMs;
  return Math.round(minMs + random() * (maxMs - minMs));
}

/** Waits between independent probe calls while allowing the probe deadline or SIGTERM to stop it. */
export function waitForAbortableProbeDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

let activeProbePhase: ProbePhase = 'configuration';

class ProbeFailure extends Error {
  constructor(
    readonly code: ProbeFailureCode,
    readonly phase: ProbePhase,
  ) {
    super(code);
  }
}

function reportFailure(code: ProbeFailureCode, phase: ProbePhase): void {
  // Do not echo dependency errors: they can contain a proxy URL or other sensitive input.
  console.error(JSON.stringify({ event: 'accuracy_probe_failed', code, phase }));
}

async function main(): Promise<void> {
  activeProbePhase = 'configuration';
  let requested: AccuracyProbeConfig;
  try {
    requested = loadAccuracyProbeConfig();
  } catch {
    throw new ProbeFailure('invalid_probe_config', activeProbePhase);
  }
  if (!requested.confirmLive) {
    throw new ProbeFailure('live_confirmation_required', activeProbePhase);
  }
  if (!requested.localCaptchaEnabled) {
    // A live probe without the local path would consume Google/proxy traffic but prove nothing for G6.
    throw new ProbeFailure('local_captcha_required', activeProbePhase);
  }

  activeProbePhase = 'safety_guards';
  applyAccuracyProbeSafetyGuards();
  const probeConfig = loadAccuracyProbeConfig();
  activeProbePhase = 'query_build';
  const queries = buildAccuracyProbeQueries(probeConfig);
  const collector = new AccuracyProbeCollector();
  const cancellation = createProbeCancellation(probeConfig.maxDurationMs);
  let stopReason: ProbeStopReason =
    queries.length === 0 ? 'no_queries' : 'query_limit';

  // These modules read their config at import time, so they must load after the probe guards above.
  activeProbePhase = 'crawler_import';
  let CaptchaSolver: (typeof import('./src/captcha_solver'))['CaptchaSolver'];
  try {
    ({ CaptchaSolver } = await import('./src/captcha_solver'));
  } catch {
    throw new ProbeFailure('captcha_module_import_failed', activeProbePhase);
  }
  let closeGoogleCrawler: (typeof import('./src/google_crawler'))['closeGoogleCrawler'];
  let getGoogleCrawlerDiagnostics: (typeof import('./src/google_crawler'))['getGoogleCrawlerDiagnostics'];
  let runGoogleCrawler: (typeof import('./src/google_crawler'))['runGoogleCrawler'];
  try {
    ({ closeGoogleCrawler, getGoogleCrawlerDiagnostics, runGoogleCrawler } = await import(
      './src/google_crawler'
    ));
  } catch {
    throw new ProbeFailure('crawler_module_import_failed', activeProbePhase);
  }
  const { config: runtimeConfig } = await import('./src/config');
  let probePool: import('./src/proxy_pool').ProxyPool | undefined;
  if (probeConfig.probeProxyLabels) {
    try {
      const { loadProxyPool } = await import('./src/proxy_pool');
      probePool = (await loadProxyPool()).selectProbeLabels(probeConfig.probeProxyLabels);
    } catch {
      throw new ProbeFailure('proxy_selection_failed', activeProbePhase);
    }
  }

  let cleanup = {
    worker_restarts: 0,
    circuit_open: false,
    active_children: 0,
    pending_requests: 0,
    active_temp_dirs: 0,
  };
  try {
    activeProbePhase = 'crawler_execution';
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex];
      if (cancellation.signal.aborted) {
        stopReason = cancellation.stopReason();
        break;
      }
      const shouldStop = collector.shouldStop(probeConfig);
      if (shouldStop) {
        stopReason = shouldStop;
        break;
      }
      if (queryIndex > 0) {
        const completedDelay = await waitForAbortableProbeDelay(
          probeDelayMs(
            runtimeConfig.search.queryDelayMinMs,
            runtimeConfig.search.queryDelayMaxMs,
          ),
          cancellation.signal,
        );
        if (!completedDelay) {
          stopReason = cancellation.stopReason();
          break;
        }
      }

      collector.recordQueryStarted();
      let organicResults = 0;
      let eligibleResults = 0;
      const stats = await runGoogleCrawler({
        queries: [query],
        // Passing an empty key prevents 2Captcha even if a caller accidentally inherited one.
        captchaSolver: new CaptchaSolver(''),
        proxyPool: probePool,
        abortSignal: cancellation.signal,
        onCaptchaEvent: (event: ProbeCaptchaEvent) => collector.recordCaptchaEvent(event),
        onResults: async (results, queryId) => {
          const site = queryId === query.id ? query.site : '';
          organicResults += results.length;
          const clean = results.filter((result) => {
            return (
              isEligiblePostUrl(result.url, site) &&
              Boolean(extractPostId(result.url, site)) &&
              !isLikelyAdResult(result.title, result.snippet)
            );
          }).length;
          eligibleResults += clean;
          return clean;
        },
        logPrefix: 'accuracy_probe',
      });

      const blocked = stats.blockedQueries.length > 0;
      collector.recordQueryCompleted({
        succeeded: !cancellation.signal.aborted && !blocked && stats.failedQueries.length === 0,
        blocked,
        organicResults,
        eligibleResults,
      });
      if (cancellation.signal.aborted) {
        stopReason = cancellation.stopReason();
        break;
      }
    }
  } finally {
    activeProbePhase = 'cleanup';
    cancellation.dispose();
    await closeGoogleCrawler();
    const diagnostics = getGoogleCrawlerDiagnostics();
    cleanup = {
      worker_restarts: diagnostics.workerRestarts,
      circuit_open: diagnostics.circuitOpen,
      active_children: diagnostics.activeChildren,
      pending_requests: diagnostics.pendingRequests,
      active_temp_dirs: diagnostics.activeTempDirs,
    };
  }

  activeProbePhase = 'report';
  console.log(JSON.stringify(collector.report(probeConfig, queries.length, stopReason, Date.now(), cleanup)));
}

if (require.main === module) {
  main().catch((error) => {
    reportFailure(
      error instanceof ProbeFailure ? error.code : 'probe_failed',
      error instanceof ProbeFailure ? error.phase : activeProbePhase,
    );
    process.exitCode = 1;
  });
}
