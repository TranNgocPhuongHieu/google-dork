import { Browser, BrowserContext, Frame, Page, chromium } from 'playwright';
import { CaptchaSolver } from './captcha_solver';
import { config } from './config';
import { createLogger } from './logger';
import {
  isRecaptchaAudioUrl,
  LocalCaptchaDiagnostics,
  LocalCaptchaSolver,
  LocalCaptchaSolveOutcome,
} from './local_captcha_solver';
import {
  loadProxyPool,
  ProxyEntry,
  ProxyPool,
  toPlaywrightProxy,
} from './proxy_pool';
import {
  CrawlerProgress,
  CrawlerStats,
  OnResultsCallback,
  SearchResult,
} from './types';
import { GoogleTimeFilter } from './query_builder';
import { VoskTranscriber } from './vosk_transcriber';

const logger = createLogger('google_crawler');
const RESULT_SELECTOR = 'div.tF2Cxc:not(:has(div.tF2Cxc))';
const RESULT_FALLBACK_SELECTOR = 'div[data-hveid][data-ved]';
const CAPTCHA_SELECTOR = 'div[data-sitekey], form#captcha-form, iframe[src*="recaptcha"]';
const PRIMARY_RESULT_LIMIT = 10;
const ACCEPT_LANGUAGE_HEADER = 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7';
const RECAPTCHA_AUDIO_RESPONSE_TIMEOUT_MS = 12_000;
const RECAPTCHA_AUDIO_CONTROL_ACTION_TIMEOUT_MS = 9_000;
const RECAPTCHA_ANSWER_VERIFICATION_TIMEOUT_MS = 10_000;
const RECAPTCHA_ANSWER_STATE_TIMEOUT_MS = 2_000;
const RECAPTCHA_ANSWER_STATE_POLL_MS = 100;
const RECAPTCHA_AUDIO_MAX_BYTES = 2 * 1024 * 1024;

export type RecaptchaAudioCaptureFailureCode =
  | 'audio_control_unavailable'
  | 'audio_control_not_visible'
  | 'audio_control_disabled'
  | 'audio_control_click_failed'
  | 'audio_response_timeout'
  | 'audio_response_http_error'
  | 'audio_payload_too_large'
  | 'audio_payload_body_unavailable';

export type RecaptchaAudioCapture =
  | {
      status: 'success';
      audioUrl: string;
      audioBytes: Buffer;
      contentType: string | null;
    }
  | { status: 'failure'; reasonCode: RecaptchaAudioCaptureFailureCode };

type RecaptchaAnswerVerificationOutcome =
  | 'verified'
  | 'answer_verification_timeout'
  | 'answer_verification_http_error'
  | 'answer_verification_unsolved';

const AUDIO_REQUESTED_FAILURES = new Set<RecaptchaAudioCaptureFailureCode>([
  'audio_response_timeout',
  'audio_response_http_error',
  'audio_payload_too_large',
  'audio_payload_body_unavailable',
]);

export const GOOGLE_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-http2',
  '--disable-quic',
] as const;

export type CaptchaCrawlerEvent = {
  event:
    | 'captcha_audio_offered'
    | 'captcha_local_attempt'
    | 'captcha_local_result'
    | 'captcha_paid_fallback'
    | 'captcha_hard_block';
  proxyLabel?: string;
  status?: 'success' | 'failure';
  reasonCode?: string;
  durationMs?: number;
  /**
   * 'capture' marks a failure that happened before any audio reached the solver,
   * so counters can keep solver accuracy separate from proxy reachability.
   */
  stage?: 'capture' | 'solve';
};

export type CaptchaCrawlerEventCallback = (event: CaptchaCrawlerEvent) => void;

export interface GoogleCrawlerDiagnostics {
  workerRestarts: number;
  circuitOpen: boolean;
  activeChildren: number;
  pendingRequests: number;
  activeTempDirs: number;
}

export function buildDesktopUserAgent(browserVersion: string): string {
  const version = browserVersion.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export type GoogleCrawlerErrorKind = 'network' | 'captcha' | 'parse';

export class GoogleCrawlerError extends Error {
  constructor(message: string, public readonly kind: GoogleCrawlerErrorKind) {
    super(message);
    this.name = 'GoogleCrawlerError';
  }
}

class GoogleCrawlerAbortError extends Error {
  constructor() {
    super('Google crawler cancelled');
    this.name = 'GoogleCrawlerAbortError';
  }
}

export interface GoogleQuerySpec {
  id: string;
  query: string;
  site: string;
  maxPages: number;
  timeFilter?: GoogleTimeFilter;
}

export interface GoogleCrawlerOptions {
  queries: GoogleQuerySpec[];
  onResults: OnResultsCallback;
  onProgress?: (progress: CrawlerProgress) => void;
  logPrefix?: string;
  proxyPool?: ProxyPool;
  captchaSolver?: CaptchaSolver;
  localCaptchaSolver?: LocalCaptchaSolver;
  onCaptchaEvent?: CaptchaCrawlerEventCallback;
  /** Optional cancellation used by the no-write accuracy probe; production leaves it unset. */
  abortSignal?: AbortSignal;
}

interface AttemptResult {
  pages: SearchResult[][];
}

let browserPromise: Promise<Browser> | undefined;
let defaultProxyPool: ProxyPool | undefined;
let defaultLocalCaptchaSolver: LocalCaptchaSolver | undefined;
let lastLocalCaptchaDiagnostics: GoogleCrawlerDiagnostics = {
  workerRestarts: 0,
  circuitOpen: false,
  activeChildren: 0,
  pendingRequests: 0,
  activeTempDirs: 0,
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GoogleCrawlerAbortError();
}

function isCrawlerAbort(error: unknown): boolean {
  return error instanceof GoogleCrawlerAbortError;
}

/** Error text from browser/proxy libraries may contain credentials or URLs. */
export function crawlerFailureCode(error: unknown): GoogleCrawlerErrorKind | 'unexpected' {
  return error instanceof GoogleCrawlerError ? error.kind : 'unexpected';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new GoogleCrawlerAbortError());
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function randomDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

async function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch({
    headless: config.browser.headless,
    args: [...GOOGLE_BROWSER_ARGS],
  });
  return browserPromise;
}

function toCrawlerDiagnostics(diagnostics: LocalCaptchaDiagnostics): GoogleCrawlerDiagnostics {
  return {
    workerRestarts: diagnostics.workerRestarts,
    circuitOpen: diagnostics.circuitOpen,
    activeChildren: diagnostics.activeChildren,
    pendingRequests: diagnostics.pendingRequests,
    activeTempDirs: diagnostics.activeTempDirs,
  };
}

function getDefaultLocalCaptchaSolver(): LocalCaptchaSolver | undefined {
  if (!config.captcha.localAudioEnabled) return undefined;
  defaultLocalCaptchaSolver ??= new LocalCaptchaSolver({
    ffmpegPath: config.captcha.ffmpegPath,
    timeoutMs: config.captcha.localTimeoutMs,
    transcriber: new VoskTranscriber({
      modelPath: config.captcha.voskModelPath,
      libraryPath: config.captcha.voskLibraryPath,
      requestTimeoutMs: config.captcha.localTimeoutMs,
      shutdownTimeoutMs: config.captcha.workerShutdownMs,
    }),
  });
  return defaultLocalCaptchaSolver;
}

async function getProxyPool(): Promise<ProxyPool> {
  if (!defaultProxyPool) {
    defaultProxyPool = await loadProxyPool();
  }
  return defaultProxyPool;
}

export async function closeGoogleCrawler(): Promise<void> {
  const active = browserPromise;
  const localSolver = defaultLocalCaptchaSolver;
  browserPromise = undefined;
  defaultLocalCaptchaSolver = undefined;
  const closeBrowser = active
    ? active.then((browser) => browser.close()).catch(() => {})
    : Promise.resolve();
  const closeLocalSolver = localSolver
    ? localSolver.close().catch(() => {}).then(() => {
        lastLocalCaptchaDiagnostics = toCrawlerDiagnostics(localSolver.diagnostics());
      })
    : Promise.resolve();
  await Promise.all([closeBrowser, closeLocalSolver]);
}

export function getGoogleCrawlerDiagnostics(): GoogleCrawlerDiagnostics {
  return defaultLocalCaptchaSolver
    ? toCrawlerDiagnostics(defaultLocalCaptchaSolver.diagnostics())
    : { ...lastLocalCaptchaDiagnostics };
}

function googleTimeParam(filter: GoogleTimeFilter | undefined): string | undefined {
  switch (filter) {
    case 'past_hour':
      return 'qdr:h';
    case 'past_24_hours':
      return 'qdr:d';
    case 'past_week':
      return 'qdr:w';
    case 'past_month':
      return 'qdr:m';
    default:
      return undefined;
  }
}

export function buildGoogleSearchUrl(spec: GoogleQuerySpec, start: number): string {
  const params = new URLSearchParams({
    q: spec.query,
    hl: 'vi',
    gl: 'vn',
    pws: '0',
    filter: '0',
    num: String(PRIMARY_RESULT_LIMIT),
    start: String(start),
  });
  const tbs = googleTimeParam(spec.timeFilter);
  if (tbs) params.set('tbs', tbs);
  return `https://www.google.com/search?${params.toString()}`;
}

export function normalizeGoogleResultUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw, 'https://www.google.com');
    if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url');
      return target ? new URL(target).toString() : undefined;
    }
    if (parsed.hostname.endsWith('google.com')) return undefined;
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function htmlLooksLikeCaptcha(html: string, url = ''): boolean {
  const value = `${url}\n${html}`.toLowerCase();
  return (
    value.includes('/sorry/') ||
    value.includes('g-recaptcha') ||
    value.includes('data-sitekey') ||
    value.includes('unusual traffic') ||
    value.includes('lưu lượng truy cập bất thường')
  );
}

function isRecaptchaFrame(frame: Frame, kind: 'anchor' | 'challenge'): boolean {
  try {
    const url = new URL(frame.url());
    const host = url.hostname.toLowerCase();
    const allowedHost =
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'recaptcha.net' ||
      host.endsWith('.recaptcha.net');
    const endpoint = kind === 'anchor' ? 'anchor' : 'bframe';
    return (
      url.protocol === 'https:' &&
      allowedHost &&
      new RegExp(`^/recaptcha/(?:api2|enterprise)/${endpoint}(?:/|$)`).test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function shouldAbortBrowserRequest(resourceType: string, url: string): boolean {
  if (resourceType === 'image' || resourceType === 'font') return true;
  return resourceType === 'media' && !isRecaptchaAudioUrl(url);
}

function emitCaptchaEvent(callback: CaptchaCrawlerEventCallback | undefined, event: CaptchaCrawlerEvent): void {
  try {
    callback?.(event);
  } catch {
    // Probe telemetry is advisory and must not interrupt crawler recovery.
  }
}

export async function isCaptchaPage(page: Page): Promise<boolean> {
  if (page.url().includes('/sorry/')) return true;
  if ((await page.locator(CAPTCHA_SELECTOR).count()) > 0) return true;
  const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  return htmlLooksLikeCaptcha(body, page.url());
}

export async function isHardCaptchaBlock(page: Page): Promise<boolean> {
  const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  return /try again later|please try again later|hãy thử lại sau|vui lòng thử lại sau/i.test(body);
}

async function findRecaptchaFrame(
  page: Page,
  kind: 'anchor' | 'challenge',
  timeoutMs: number,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeoutMs;
  const selector = kind === 'anchor' ? '#recaptcha-anchor' : '#recaptcha-audio-button';
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isRecaptchaFrame(frame, kind)) continue;
      if ((await frame.locator(selector).count().catch(() => 0)) > 0) return frame;
    }
    await sleep(100);
  }
  return undefined;
}

/**
 * A reCAPTCHA bframe is not created until its checkbox has been activated on
 * many Google challenge pages. Reuse an already-open challenge to avoid
 * toggling a checkbox that is in the middle of a verification attempt.
 */
export async function openRecaptchaAudioChallenge(page: Page): Promise<Frame | undefined> {
  const existing = await findRecaptchaFrame(page, 'challenge', 1_000);
  if (existing) return existing;

  const anchor = await findRecaptchaFrame(page, 'anchor', 5_000);
  if (!anchor) return undefined;
  const checkbox = anchor.locator('#recaptcha-anchor').first();
  if ((await checkbox.count().catch(() => 0)) === 0) return undefined;
  const checked = await checkbox.getAttribute('aria-checked').catch(() => null);
  if (checked !== 'true') await checkbox.click({ timeout: 5_000 }).catch(() => {});
  return findRecaptchaFrame(page, 'challenge', 5_000);
}

export type RecaptchaAudioControlState =
  | 'audio_control_enabled'
  | 'audio_control_unavailable'
  | 'audio_control_not_visible'
  | 'audio_control_disabled';

/**
 * Read-only triage of an audio control. Nothing is clicked, so no audio is
 * requested and the solver is never involved. The cheap pre-flight probe uses
 * this on its own; `captureRecaptchaAudio` uses it as its first step so both
 * report identical reason codes.
 */
export async function inspectRecaptchaAudioControl(
  challengeFrame: Frame,
  reload = false,
): Promise<RecaptchaAudioControlState> {
  const control = challengeFrame.locator(reload ? '#recaptcha-reload-button' : '#recaptcha-audio-button').first();
  if ((await control.count().catch(() => 0)) === 0) return 'audio_control_unavailable';
  if (!(await control.isVisible().catch(() => false))) return 'audio_control_not_visible';
  if (!(await control.isEnabled().catch(() => false))) return 'audio_control_disabled';
  return 'audio_control_enabled';
}

export async function captureRecaptchaAudio(
  page: Page,
  challengeFrame: Frame,
  reload: boolean,
): Promise<RecaptchaAudioCapture> {
  const controlState = await inspectRecaptchaAudioControl(challengeFrame, reload);
  if (controlState !== 'audio_control_enabled') {
    return { status: 'failure', reasonCode: controlState };
  }
  const control = challengeFrame.locator(reload ? '#recaptcha-reload-button' : '#recaptcha-audio-button').first();

  const responsePromise = page
    .waitForResponse((response) => isRecaptchaAudioUrl(response.url()), {
      // The listener must be armed before a click, but a forced click can take
      // nine seconds. Preserve a full response window after that click.
      timeout: RECAPTCHA_AUDIO_RESPONSE_TIMEOUT_MS + RECAPTCHA_AUDIO_CONTROL_ACTION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  const clicked = await control.click({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (!clicked) {
    await control.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    const forced = await control.click({ timeout: 2_000, force: true }).then(
      () => true,
      () => false,
    );
    if (!forced) return { status: 'failure', reasonCode: 'audio_control_click_failed' };
  }
  const response = await responsePromise;
  if (!response) return { status: 'failure', reasonCode: 'audio_response_timeout' };
  if (!response.ok()) return { status: 'failure', reasonCode: 'audio_response_http_error' };

  const declaredLength = Number(response.headers()['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > RECAPTCHA_AUDIO_MAX_BYTES) {
    return { status: 'failure', reasonCode: 'audio_payload_too_large' };
  }
  const audioBytes = await response.body().catch(() => undefined);
  if (!audioBytes) return { status: 'failure', reasonCode: 'audio_payload_body_unavailable' };
  if (audioBytes.length > RECAPTCHA_AUDIO_MAX_BYTES) {
    return { status: 'failure', reasonCode: 'audio_payload_too_large' };
  }
  return {
    status: 'success',
    audioUrl: response.url(),
    audioBytes,
    contentType: response.headers()['content-type'] ?? null,
  };
}

/** Reload only when the prior action reached a state that can have audio loaded. */
export function shouldReloadRecaptchaAudio(capture: RecaptchaAudioCapture): boolean {
  return capture.status === 'success' || AUDIO_REQUESTED_FAILURES.has(capture.reasonCode);
}

async function hasVerifiedAudioAnswerState(page: Page): Promise<boolean> {
  const anchorFrame = await findRecaptchaFrame(page, 'anchor', 200);
  const checkboxSolved =
    (await anchorFrame?.locator('#recaptcha-anchor').getAttribute('aria-checked').catch(() => null)) ===
    'true';
  if (checkboxSolved) return true;

  const escapedSorry = !page.url().includes('/sorry/');
  const hasSerp = (await page.locator(`${RESULT_SELECTOR}, ${RESULT_FALLBACK_SELECTOR}`).count()) > 0;
  return escapedSorry && hasSerp;
}

export async function waitForAudioAnswerVerification(
  page: Page,
): Promise<RecaptchaAnswerVerificationOutcome> {
  const verification = await page
    .waitForResponse(
      (response) => {
        try {
          const url = new URL(response.url());
          return (
            url.protocol === 'https:' &&
            /(^|\.)google\.com$|(^|\.)recaptcha\.net$/i.test(url.hostname) &&
            /^\/recaptcha\/(?:api2|enterprise)\/userverify(?:\/|$)/.test(url.pathname)
          );
        } catch {
          return false;
        }
      },
      { timeout: RECAPTCHA_ANSWER_VERIFICATION_TIMEOUT_MS },
    )
    .catch(() => undefined);
  if (!verification) return 'answer_verification_timeout';
  if (!verification.ok()) return 'answer_verification_http_error';

  const deadline = Date.now() + RECAPTCHA_ANSWER_STATE_TIMEOUT_MS;
  do {
    if (await hasVerifiedAudioAnswerState(page)) return 'verified';
    if (Date.now() >= deadline) break;
    await sleep(RECAPTCHA_ANSWER_STATE_POLL_MS);
  } while (Date.now() < deadline);
  return 'answer_verification_unsolved';
}

export async function acceptConsent(page: Page): Promise<void> {
  const names = [/Chấp nhận tất cả/i, /Tôi đồng ý/i, /Accept all/i, /I agree/i];
  for (const name of names) {
    const button = page.getByRole('button', { name }).first();
    if ((await button.count()) === 0) continue;
    await button.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    return;
  }
}

export async function extractGoogleResults(page: Page): Promise<SearchResult[]> {
  let blocks = page.locator(RESULT_SELECTOR);
  if ((await blocks.count()) === 0) blocks = page.locator(RESULT_FALLBACK_SELECTOR);

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < (await blocks.count()); index++) {
    const block = blocks.nth(index);
    if (
      (await block.getAttribute('data-text-ad')) !== null ||
      (await block.locator('[data-text-ad]').count()) > 0
    ) {
      continue;
    }
    const titleNode = block.locator('h3').first();
    if ((await titleNode.count()) === 0) continue;
    const title = (await titleNode.innerText().catch(() => '')).trim();
    if (!title) continue;

    let anchor = titleNode.locator('xpath=ancestor::a[1]');
    if ((await anchor.count()) === 0) anchor = block.locator('a:has(h3)').first();
    const href = await anchor.getAttribute('href').catch(() => null);
    const url = normalizeGoogleResultUrl(href ?? '');
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let snippet = '';
    for (const selector of ["div[data-sncf='1'] div", 'div.VwiC3b']) {
      const node = block.locator(selector).first();
      if ((await node.count()) === 0) continue;
      snippet = (await node.innerText().catch(() => '')).trim();
      if (snippet) break;
    }
    results.push({ url, title, snippet, source: 'google', engagement: '' });
  }
  return results;
}

async function waitForSerp(page: Page): Promise<void> {
  await Promise.race([
    page.locator(RESULT_SELECTOR).first().waitFor({
      state: 'attached',
      timeout: config.browser.resultWaitTimeoutMs,
    }),
    page.locator(CAPTCHA_SELECTOR).first().waitFor({
      state: 'attached',
      timeout: config.browser.resultWaitTimeoutMs,
    }),
  ]).catch(() => {});
}

async function solveCaptchaWithLocalAudio(
  page: Page,
  proxy: ProxyEntry,
  localSolver: LocalCaptchaSolver,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<boolean> {
  let reloadAudio = false;
  for (let attempt = 1; attempt <= config.captcha.localMaxAttempts; attempt++) {
    throwIfAborted(abortSignal);
    const challengeFrame = await openRecaptchaAudioChallenge(page);
    if (!challengeFrame) {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: 'challenge_unavailable',
        stage: 'capture',
      });
      return false;
    }

    const localAttemptStartedAt = Date.now();
    const audio = await captureRecaptchaAudio(page, challengeFrame, reloadAudio);
    throwIfAborted(abortSignal);
    if (audio.status === 'failure') {
      reloadAudio = reloadAudio || shouldReloadRecaptchaAudio(audio);
      // No audio reached the solver, so this is deliberately NOT reported as an
      // audio_offered/local_attempt pair. Counting it as a solver attempt is what
      // produced the local_attempted=0 / local_failed=70 contradiction in G6 t1220.
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: audio.reasonCode,
        stage: 'capture',
      });
      continue;
    }
    reloadAudio = true;

    emitCaptchaEvent(onCaptchaEvent, { event: 'captcha_audio_offered', proxyLabel: proxy.label });
    emitCaptchaEvent(onCaptchaEvent, { event: 'captcha_local_attempt', proxyLabel: proxy.label });
    const outcome: LocalCaptchaSolveOutcome = await localSolver.solveAudio({
      ...audio,
      proxyLabel: proxy.label,
      signal: abortSignal,
    });
    if (outcome.status === 'failure') {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: outcome.reasonCode,
        durationMs: outcome.durationMs,
        stage: 'solve',
      });
      continue;
    }

    const answer = challengeFrame.locator('#audio-response').first();
    const verify = challengeFrame.locator('#recaptcha-verify-button').first();
    if ((await answer.count().catch(() => 0)) === 0 || (await verify.count().catch(() => 0)) === 0) {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: 'answer_controls_unavailable',
        durationMs: Math.max(outcome.durationMs, Date.now() - localAttemptStartedAt),
        stage: 'solve',
      });
      continue;
    }

    const answerFilled = await answer.fill(outcome.answer, { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (!answerFilled) {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: 'answer_fill_failed',
        durationMs: Math.max(outcome.durationMs, Date.now() - localAttemptStartedAt),
        stage: 'solve',
      });
      continue;
    }

    const verification = waitForAudioAnswerVerification(page);
    const verificationClicked = await verify.click({ timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (!verificationClicked) {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'failure',
        reasonCode: 'answer_verify_click_failed',
        durationMs: Math.max(outcome.durationMs, Date.now() - localAttemptStartedAt),
        stage: 'solve',
      });
      continue;
    }

    const verificationOutcome = await verification;
    const durationMs = Math.max(outcome.durationMs, Date.now() - localAttemptStartedAt);
    if (verificationOutcome === 'verified') {
      emitCaptchaEvent(onCaptchaEvent, {
        event: 'captcha_local_result',
        proxyLabel: proxy.label,
        status: 'success',
        durationMs,
        stage: 'solve',
      });
      return true;
    }
    emitCaptchaEvent(onCaptchaEvent, {
      event: 'captcha_local_result',
      proxyLabel: proxy.label,
      status: 'failure',
      reasonCode: verificationOutcome,
      durationMs,
      stage: 'solve',
    });
  }
  return false;
}

async function solvePaidCaptchaOnPage(
  page: Page,
  context: BrowserContext,
  proxy: ProxyEntry,
  solver: CaptchaSolver,
): Promise<boolean> {
  const captchaElement = page.locator('[data-sitekey]').first();
  let websiteKey = await captchaElement.getAttribute('data-sitekey').catch(() => null);
  let dataS = await captchaElement.getAttribute('data-s').catch(() => null);

  if (!websiteKey) {
    const iframeSrc = await page
      .locator('iframe[src*="recaptcha"]')
      .first()
      .getAttribute('src')
      .catch(() => null);
    if (iframeSrc) {
      const iframeUrl = new URL(iframeSrc, page.url());
      websiteKey = iframeUrl.searchParams.get('k');
      dataS ??= iframeUrl.searchParams.get('s');
    }
  }
  if (!websiteKey) throw new Error('captcha sitekey was not found');

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const cookies = (await context.cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  const solution = await solver.solve({
    websiteUrl: page.url(),
    websiteKey,
    dataS: dataS ?? undefined,
    userAgent,
    cookies,
    proxyUrl: proxy.url,
  });

  await page.evaluate((token) => {
    let textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response',
    );
    if (!textarea) {
      textarea = document.createElement('textarea');
      textarea.name = 'g-recaptcha-response';
      textarea.id = 'g-recaptcha-response';
      textarea.hidden = true;
      document.body.appendChild(textarea);
    }
    textarea.value = token;
    textarea.innerHTML = token;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    const callback = (window as unknown as { submitCallback?: () => void }).submitCallback;
    if (typeof callback === 'function') callback();
    else document.querySelector<HTMLFormElement>('form#captcha-form')?.submit();
  }, solution.token);

  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  await sleep(2_000);
  return !(await isCaptchaPage(page));
}

async function solveCaptchaOnPage(
  page: Page,
  context: BrowserContext,
  proxy: ProxyEntry,
  solver: CaptchaSolver,
  localSolver: LocalCaptchaSolver | undefined,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<boolean> {
  if (
    localSolver &&
    (await solveCaptchaWithLocalAudio(page, proxy, localSolver, onCaptchaEvent, abortSignal))
  ) {
    return true;
  }
  throwIfAborted(abortSignal);
  if (!solver.enabled) return false;
  emitCaptchaEvent(onCaptchaEvent, { event: 'captcha_paid_fallback', proxyLabel: proxy.label });
  return solvePaidCaptchaOnPage(page, context, proxy, solver);
}

export async function createContext(proxy: ProxyEntry): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    proxy: toPlaywrightProxy(proxy.url),
    locale: config.browser.locale,
    timezoneId: config.timezone,
    viewport: { width: 1365, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    userAgent: buildDesktopUserAgent(browser.version()),
    extraHTTPHeaders: {
      'Accept-Language': ACCEPT_LANGUAGE_HEADER,
    },
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.route('**/*', async (route) => {
    if (shouldAbortBrowserRequest(route.request().resourceType(), route.request().url())) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
  return context;
}

async function searchWithProxy(
  spec: GoogleQuerySpec,
  proxy: ProxyEntry,
  solver: CaptchaSolver,
  localSolver: LocalCaptchaSolver | undefined,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  allowCaptchaSolve: boolean,
  abortSignal: AbortSignal | undefined,
): Promise<AttemptResult> {
  let context: BrowserContext | undefined;
  const closeContextOnAbort = () => {
    void context?.close().catch(() => {});
  };
  abortSignal?.addEventListener('abort', closeContextOnAbort, { once: true });
  try {
    throwIfAborted(abortSignal);
    context = await createContext(proxy);
    throwIfAborted(abortSignal);
    const page = await context.newPage();
    const pages: SearchResult[][] = [];
    const seen = new Set<string>();

    for (let pageNumber = 1; pageNumber <= spec.maxPages; pageNumber++) {
      if (pageNumber > 1) {
        await sleep(randomDelay(config.search.pageDelayMinMs, config.search.pageDelayMaxMs), abortSignal);
      }
      const url = buildGoogleSearchUrl(spec, (pageNumber - 1) * PRIMARY_RESULT_LIMIT);
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs,
      });
      throwIfAborted(abortSignal);
      if (response && response.status() >= 500) {
        throw new GoogleCrawlerError(`Google HTTP ${response.status()}`, 'network');
      }
      await acceptConsent(page);
      await waitForSerp(page);
      throwIfAborted(abortSignal);

      if (await isCaptchaPage(page)) {
        if (await isHardCaptchaBlock(page)) {
          emitCaptchaEvent(onCaptchaEvent, { event: 'captcha_hard_block', proxyLabel: proxy.label });
          throw new GoogleCrawlerError('Google hard captcha block', 'captcha');
        }
        if (!allowCaptchaSolve) {
          throw new GoogleCrawlerError('Google captcha detected', 'captcha');
        }
        const solved = await solveCaptchaOnPage(
          page,
          context,
          proxy,
          solver,
          localSolver,
          onCaptchaEvent,
          abortSignal,
        ).catch((error) => {
          if (isCrawlerAbort(error)) throw error;
          logger.warning(`captcha_solve_failed proxy=${proxy.label} code=${crawlerFailureCode(error)}`);
          return false;
        });
        if (!solved) {
          const reason = solver.enabled || localSolver
            ? 'captcha solvers returned no valid solution'
            : 'captcha solvers disabled';
          throw new GoogleCrawlerError(`Google captcha solve failed: ${reason}`, 'captcha');
        }
        await waitForSerp(page);
        throwIfAborted(abortSignal);
      }

      const extracted = await extractGoogleResults(page);
      const fresh = extracted.filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
      if (fresh.length === 0) {
        const body = await page.locator('body').innerText().catch(() => '');
        const noResults = /không tìm thấy kết quả|did not match any documents|no results/i.test(body);
        if (pageNumber === 1 && !noResults && (await page.locator('h3').count()) > 0) {
          throw new GoogleCrawlerError('Google SERP selector drift', 'parse');
        }
        break;
      }
      pages.push(fresh);

      const hasNext = (await page.locator('#pnnext, a[aria-label="Next"], a[aria-label="Tiếp"]')
        .count()) > 0;
      if (!hasNext || extracted.length < PRIMARY_RESULT_LIMIT) break;
    }
    return { pages };
  } catch (error) {
    if (isCrawlerAbort(error) || abortSignal?.aborted) throw new GoogleCrawlerAbortError();
    if (error instanceof GoogleCrawlerError) throw error;
    throw new GoogleCrawlerError('Google browser request failed', 'network');
  } finally {
    abortSignal?.removeEventListener('abort', closeContextOnAbort);
    await context?.close().catch(() => {});
  }
}

async function runFixedAttempts(
  spec: GoogleQuerySpec,
  pool: ProxyPool,
  solver: CaptchaSolver,
  localSolver: LocalCaptchaSolver | undefined,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  prefix: string,
  abortSignal: AbortSignal | undefined,
): Promise<{ result?: AttemptResult; proxy?: ProxyEntry; lastError?: GoogleCrawlerError }> {
  const excluded = new Set<string>();
  let captchaHits = 0;
  let lastError: GoogleCrawlerError | undefined;

  for (let attempt = 1; attempt <= config.search.maxAttempts; attempt++) {
    throwIfAborted(abortSignal);
    let proxy = pool.acquirePrimary(excluded);
    if (!proxy) {
      // Pool cạn (tất cả đang cooldown). Trước đây bỏ luôn query -> `no_proxy`,
      // mất dữ liệu im lặng và không biết tỉnh nào thiếu. Nay chờ proxy sớm nhất
      // hồi, tối đa poolWaitMaxMs, rồi thử lại.
      const waitMs = pool.msUntilPrimaryAvailable(excluded);
      if (waitMs === undefined || waitMs > config.search.poolWaitMaxMs) {
        logger.warning(
          `${prefix} pool_exhausted attempt=${attempt}/${config.search.maxAttempts} ` +
            `wait_ms=${waitMs ?? 'none'} max_ms=${config.search.poolWaitMaxMs}`,
        );
        break;
      }
      logger.info(`${prefix} pool_wait attempt=${attempt}/${config.search.maxAttempts} wait_ms=${waitMs}`);
      await sleep(waitMs + 1_000, abortSignal);
      proxy = pool.acquirePrimary(excluded);
      if (!proxy) break;
    }
    excluded.add(proxy.url);
    try {
      const result = await searchWithProxy(
        spec,
        proxy,
        solver,
        localSolver,
        onCaptchaEvent,
        captchaHits >= 1,
        abortSignal,
      );
      pool.markSuccess(proxy.url);
      return { result, proxy };
    } catch (error) {
      if (isCrawlerAbort(error)) throw error;
      lastError =
        error instanceof GoogleCrawlerError
          ? error
          : new GoogleCrawlerError('Google browser request failed', 'network');
      if (lastError.kind === 'captcha') {
        captchaHits += 1;
        pool.markBlocked(proxy.url);
      } else {
        pool.markFailure(proxy.url);
      }
      logger.warning(
        `${prefix} retry=${attempt}/${config.search.maxAttempts} kind=${lastError.kind} proxy=${proxy.label}`,
      );
    }
  }
  return { lastError };
}

async function runRotatingFallback(
  spec: GoogleQuerySpec,
  pool: ProxyPool,
  solver: CaptchaSolver,
  localSolver: LocalCaptchaSolver | undefined,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  prefix: string,
  abortSignal: AbortSignal | undefined,
): Promise<{ result?: AttemptResult; proxy?: ProxyEntry; lastError?: GoogleCrawlerError }> {
  throwIfAborted(abortSignal);
  const proxy = pool.acquireRotating();
  if (!proxy) return {};
  let lastError: GoogleCrawlerError | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    throwIfAborted(abortSignal);
    try {
      const result = await searchWithProxy(
        spec,
        proxy,
        solver,
        localSolver,
        onCaptchaEvent,
        solver.enabled || Boolean(localSolver),
        abortSignal,
      );
      pool.markSuccess(proxy.url);
      return { result, proxy };
    } catch (error) {
      if (isCrawlerAbort(error)) throw error;
      lastError =
        error instanceof GoogleCrawlerError
          ? error
          : new GoogleCrawlerError('Google browser request failed', 'network');
      pool.release(proxy.url);
      logger.warning(
        `${prefix} rotating_retry=${attempt}/2 kind=${lastError.kind} proxy=${proxy.label}`,
      );
      if (attempt === 1) {
        try {
          await pool.resetRotating(proxy);
          throwIfAborted(abortSignal);
        } catch {
          pool.markFailure(proxy.url);
          logger.warning(`${prefix} rotating_reset_failed`);
          break;
        }
      }
    }
  }
  if (lastError?.kind === 'captcha') pool.markBlocked(proxy.url);
  else pool.markFailure(proxy.url);
  return { lastError };
}

async function runRecoveryRotatingRounds(
  spec: GoogleQuerySpec,
  pool: ProxyPool,
  solver: CaptchaSolver,
  localSolver: LocalCaptchaSolver | undefined,
  onCaptchaEvent: CaptchaCrawlerEventCallback | undefined,
  prefix: string,
  previousError?: GoogleCrawlerError,
  abortSignal?: AbortSignal,
): Promise<{ result?: AttemptResult; proxy?: ProxyEntry; lastError?: GoogleCrawlerError }> {
  let lastError = previousError;

  for (let round = 1; round <= config.search.recoveryRotatingRounds; round++) {
    throwIfAborted(abortSignal);
    if (config.search.recoveryWaitMs > 0) {
      logger.info(`${prefix} recovery_wait round=${round}/${config.search.recoveryRotatingRounds} wait_ms=${config.search.recoveryWaitMs}`);
      await sleep(config.search.recoveryWaitMs, abortSignal);
    }

    const rotating = await runRotatingFallback(
      spec,
      pool,
      solver,
      localSolver,
      onCaptchaEvent,
      `${prefix} recovery=${round}`,
      abortSignal,
    );
    if (rotating.result) return rotating;
    if (rotating.lastError) lastError = rotating.lastError;
  }

  return { lastError };
}

export async function runGoogleCrawler(options: GoogleCrawlerOptions): Promise<CrawlerStats> {
  const { queries, onResults, onProgress, logPrefix = '' } = options;
  const { abortSignal } = options;
  const pool = options.proxyPool ?? (await getProxyPool());
  const solver = options.captchaSolver ?? new CaptchaSolver();
  const localSolver = options.localCaptchaSolver ?? getDefaultLocalCaptchaSolver();
  const stats: CrawlerStats = {
    totalQueries: queries.length,
    totalFound: 0,
    totalInserted: 0,
    totalDuplicates: 0,
    failedQueries: [],
    blockedQueries: [],
  };

  for (let index = 0; index < queries.length; index++) {
    if (abortSignal?.aborted) break;
    const spec = queries[index];
    if (index > 0) {
      try {
        await sleep(randomDelay(config.search.queryDelayMinMs, config.search.queryDelayMaxMs), abortSignal);
      } catch (error) {
        if (isCrawlerAbort(error)) break;
        throw error;
      }
    }
    const prefix = `[${logPrefix}][${index + 1}/${queries.length}][${spec.site}]`;
    logger.info(`${prefix} query_start max_pages=${spec.maxPages}`);

    let attempt: { result?: AttemptResult; proxy?: ProxyEntry; lastError?: GoogleCrawlerError };
    try {
      attempt = await runFixedAttempts(
        spec,
        pool,
        solver,
        localSolver,
        options.onCaptchaEvent,
        prefix,
        abortSignal,
      );
      if (!attempt.result) {
        const rotating = await runRotatingFallback(
          spec,
          pool,
          solver,
          localSolver,
          options.onCaptchaEvent,
          prefix,
          abortSignal,
        );
        if (rotating.result) attempt = rotating;
        else if (rotating.lastError) attempt.lastError = rotating.lastError;
      }

      if (!attempt.result && config.search.recoveryRotatingRounds > 0) {
        const recovery = await runRecoveryRotatingRounds(
          spec,
          pool,
          solver,
          localSolver,
          options.onCaptchaEvent,
          prefix,
          attempt.lastError,
          abortSignal,
        );
        if (recovery.result) attempt = recovery;
        else if (recovery.lastError) attempt.lastError = recovery.lastError;
      }
    } catch (error) {
      if (isCrawlerAbort(error)) {
        logger.info(`${prefix} query_cancelled`);
        break;
      }
      throw error;
    }

    if (!attempt.result) {
      const error = attempt.lastError;
      if (error?.kind === 'captcha') stats.blockedQueries.push(spec.id);
      else stats.failedQueries.push(spec.id);
      logger.warning(`${prefix} query_failed kind=${error?.kind ?? 'no_proxy'}`);
      continue;
    }

    let queryFound = 0;
    let queryInserted = 0;
    for (let pageIndex = 0; pageIndex < attempt.result.pages.length; pageIndex++) {
      const results = attempt.result.pages[pageIndex];
      const inserted = results.length > 0 ? await onResults(results, spec.id) : 0;
      queryFound += results.length;
      queryInserted += inserted;
      try {
        onProgress?.({
          query: spec.id,
          page: pageIndex + 1,
          found: results.length,
          inserted,
          duplicates: Math.max(0, results.length - inserted),
          hasNextPage: pageIndex + 1 < attempt.result.pages.length,
        });
      } catch {
        // Monitoring must never break discovery.
      }
    }

    stats.totalFound += queryFound;
    stats.totalInserted += queryInserted;
    stats.totalDuplicates += Math.max(0, queryFound - queryInserted);
    logger.info(
      `${prefix} query_done proxy=${attempt.proxy?.label ?? '-'} pages=${attempt.result.pages.length} found=${queryFound} new=${queryInserted}`,
    );
  }

  logger.info(
    `[${logPrefix}] done found=${stats.totalFound} new=${stats.totalInserted} dup=${stats.totalDuplicates} failed=${stats.failedQueries.length} blocked=${stats.blockedQueries.length}`,
  );
  return stats;
}
