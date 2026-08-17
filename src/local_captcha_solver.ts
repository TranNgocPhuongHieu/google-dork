import { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  TranscriptionFailureCode,
  TranscriptionOutcome,
  VoskTranscriberClient,
  terminateChildProcess,
} from './vosk_transcriber';

const DEFAULT_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 30;
const DEFAULT_FFMPEG_TIMEOUT_MS = 35_000;
const MAX_PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_TRANSCRIPT_LENGTH = 200;
const MAX_FFMPEG_STDERR_BYTES = 8 * 1024;

export type LocalCaptchaFailureCode =
  | 'audio_download_failed'
  | 'audio_timeout'
  | 'audio_too_large'
  | 'audio_unavailable'
  | 'audio_unsupported_type'
  | 'busy'
  | 'cancelled'
  | 'circuit_open'
  | 'empty_transcript'
  | 'ffmpeg_failed'
  | 'ffmpeg_timeout'
  | 'invalid_audio_url'
  | 'shutdown'
  | 'temp_cleanup_failed'
  | 'timeout'
  | 'transcription_failed'
  | 'worker_crashed';

export type LocalCaptchaSolveOutcome =
  | { status: 'success'; answer: string; durationMs: number }
  | { status: 'failure'; reasonCode: LocalCaptchaFailureCode; durationMs: number };

export type CaptchaTelemetryEvent = {
  event: 'captcha_audio_offered' | 'captcha_local_attempt' | 'captcha_local_result';
  proxyLabel?: string;
  status?: 'success' | 'failure';
  reasonCode?: LocalCaptchaFailureCode;
  durationMs?: number;
};

export type CaptchaTelemetryCallback = (event: CaptchaTelemetryEvent) => void;

export interface RecaptchaAudioChallenge {
  audioUrl: string;
  /** Bytes captured through the existing Playwright page/context and proxy. */
  audioBytes?: Buffer;
  contentType?: string | null;
  proxyLabel?: string;
  signal?: AbortSignal;
}

export interface FfmpegRunOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

export type FfmpegRunner = (
  inputPath: string,
  outputPath: string,
  options: FfmpegRunOptions,
) => Promise<LocalCaptchaFailureCode | undefined>;

export interface LocalCaptchaSolverOptions {
  ffmpegPath: string;
  timeoutMs: number;
  transcriber: VoskTranscriberClient;
  fetchFn?: typeof fetch;
  telemetry?: CaptchaTelemetryCallback;
  tempRoot?: string;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
  ffmpegTimeoutMs?: number;
  ffmpegRunner?: FfmpegRunner;
  spawnFn?: typeof spawn;
}

export interface LocalCaptchaDiagnostics {
  workerRestarts: number;
  circuitOpen: boolean;
  activeChildren: number;
  pendingRequests: number;
  activeTempDirs: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function absolutePath(value: string, name: string): string {
  if (!value || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function failed(reasonCode: LocalCaptchaFailureCode, startedAt: number): LocalCaptchaSolveOutcome {
  return { status: 'failure', reasonCode, durationMs: Math.max(0, Date.now() - startedAt) };
}

function safeProxyLabel(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || /:\/\/|@|\s/.test(value)) return undefined;
  return value;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function transcriberFailureCode(reasonCode: TranscriptionFailureCode): LocalCaptchaFailureCode {
  return reasonCode;
}

function audioContentType(value: string | null): boolean {
  const normalized = value?.split(';', 1)[0].trim().toLowerCase() ?? '';
  return new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/x-wav',
    'application/octet-stream',
  ]).has(normalized);
}

function toAbortController(signal: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal) signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    },
  };
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<{ bytes?: Buffer; reasonCode?: LocalCaptchaFailureCode }> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { reasonCode: 'audio_too_large' };
  }
  if (!response.body) return { reasonCode: 'audio_download_failed' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) return { reasonCode: 'audio_too_large' };
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) };
}

/** Only accepts the HTTPS reCAPTCHA audio payload endpoints used by Google. */
export function isRecaptchaAudioUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowedHost =
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'recaptcha.net' ||
      host.endsWith('.recaptcha.net');
    const allowedPath = /^\/recaptcha\/(?:api2|enterprise)\/payload(?:\/|$)/.test(url.pathname);
    return url.protocol === 'https:' && allowedHost && allowedPath;
  } catch {
    return false;
  }
}

/**
 * Downloads only a validated reCAPTCHA audio payload, converts it to bounded
 * PCM with argv-only ffmpeg, and delegates recognition to the isolated worker.
 */
export class LocalCaptchaSolver {
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly transcriber: VoskTranscriberClient;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly telemetry?: CaptchaTelemetryCallback;
  private readonly tempRoot: string;
  private readonly maxAudioBytes: number;
  private readonly maxDurationSeconds: number;
  private readonly ffmpegTimeoutMs: number;
  private readonly ffmpegRunner?: FfmpegRunner;
  private readonly spawnFn: typeof spawn;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeFfmpeg = new Set<ChildProcess>();
  private readonly activeTempDirs = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private closing = false;

  constructor(options: LocalCaptchaSolverOptions) {
    this.ffmpegPath = absolutePath(options.ffmpegPath, 'ffmpegPath');
    this.timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs');
    this.transcriber = options.transcriber;
    // Direct fetch is opt-in for unit tests only. Production receives page-captured bytes.
    this.fetchFn = options.fetchFn;
    this.telemetry = options.telemetry;
    this.tempRoot = absolutePath(options.tempRoot ?? tmpdir(), 'tempRoot');
    this.maxAudioBytes = positiveInteger(options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES, 'maxAudioBytes');
    this.maxDurationSeconds = positiveInteger(
      options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
      'maxDurationSeconds',
    );
    this.ffmpegTimeoutMs = positiveInteger(
      options.ffmpegTimeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
      'ffmpegTimeoutMs',
    );
    this.ffmpegRunner = options.ffmpegRunner;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async solveAudio(challenge: RecaptchaAudioChallenge): Promise<LocalCaptchaSolveOutcome> {
    const startedAt = Date.now();
    const proxyLabel = safeProxyLabel(challenge.proxyLabel);
    if (this.closing) return this.report(failed('shutdown', startedAt), proxyLabel);
    if (!isRecaptchaAudioUrl(challenge.audioUrl)) {
      return this.report(failed('invalid_audio_url', startedAt), proxyLabel);
    }
    this.emit({ event: 'captcha_audio_offered', proxyLabel });
    this.emit({ event: 'captcha_local_attempt', proxyLabel });
    if (challenge.signal?.aborted) return this.report(failed('cancelled', startedAt), proxyLabel);

    const deadline = startedAt + this.timeoutMs;
    const attempt = toAbortController(challenge.signal, this.timeoutMs);
    this.activeControllers.add(attempt.controller);
    let tempPath: string | undefined;
    let outcome: LocalCaptchaSolveOutcome = failed('transcription_failed', startedAt);

    try {
      const download = await this.resolveAudio(challenge, attempt.controller.signal, deadline);
      if (!download.bytes) {
        outcome = failed(download.reasonCode ?? 'audio_download_failed', startedAt);
      } else if (remainingMs(deadline) === 0) {
        outcome = failed('timeout', startedAt);
      } else {
        tempPath = await mkdtemp(join(this.tempRoot, 'google-dork-captcha-'));
        this.activeTempDirs.add(tempPath);
        const sourcePath = join(tempPath, 'challenge.audio');
        const pcmPath = join(tempPath, 'challenge.pcm');
        await writeFile(sourcePath, download.bytes, { mode: 0o600 });

        const conversion = await this.convertAudio(sourcePath, pcmPath, attempt.controller.signal, deadline);
        if (conversion) {
          outcome = failed(conversion, startedAt);
        } else {
          const pcm = await stat(pcmPath).catch(() => undefined);
          if (!pcm || pcm.size === 0 || pcm.size > this.maxDurationSeconds * MAX_PCM_BYTES_PER_SECOND) {
            outcome = failed('ffmpeg_failed', startedAt);
          } else if (remainingMs(deadline) === 0) {
            outcome = failed('timeout', startedAt);
          } else {
            const transcription = await this.transcriber.transcribe(pcmPath, {
              signal: attempt.controller.signal,
              timeoutMs: remainingMs(deadline),
            });
            outcome = this.transcriptionOutcome(transcription, startedAt);
          }
        }
      }
    } catch {
      outcome = failed(
        this.closing ? 'shutdown' : attempt.controller.signal.aborted ? 'cancelled' : 'transcription_failed',
        startedAt,
      );
    } finally {
      attempt.cleanup();
      this.activeControllers.delete(attempt.controller);
      this.notifyIdleIfNeeded();
      if (tempPath) {
        try {
          await rm(tempPath, { recursive: true, force: true, maxRetries: 1 });
        } catch {
          outcome = failed('temp_cleanup_failed', startedAt);
        } finally {
          this.activeTempDirs.delete(tempPath);
        }
      }
    }
    return this.report(outcome, proxyLabel);
  }

  diagnostics(): LocalCaptchaDiagnostics {
    const snapshot = this.transcriberSnapshot();
    return {
      workerRestarts: snapshot?.workerRestartCount ?? 0,
      circuitOpen: snapshot?.circuitOpen ?? false,
      activeChildren: this.activeFfmpeg.size + (snapshot?.workerPid ? 1 : 0),
      pendingRequests: Number(snapshot?.active ?? false) + Number(snapshot?.queued ?? false),
      activeTempDirs: this.activeTempDirs.size,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const controller of this.activeControllers) controller.abort();
    await this.waitForActiveAttempts();
    await Promise.all(Array.from(this.activeFfmpeg, (child) => terminateChildProcess(child, 500)));
    await this.transcriber.close();
  }

  private report(outcome: LocalCaptchaSolveOutcome, proxyLabel?: string): LocalCaptchaSolveOutcome {
    this.emit({
      event: 'captcha_local_result',
      proxyLabel,
      status: outcome.status,
      ...(outcome.status === 'failure' ? { reasonCode: outcome.reasonCode } : {}),
      durationMs: outcome.durationMs,
    });
    return outcome;
  }

  private emit(event: CaptchaTelemetryEvent): void {
    try {
      this.telemetry?.(event);
    } catch {
      // Metrics must not affect CAPTCHA recovery.
    }
  }

  private async resolveAudio(
    challenge: RecaptchaAudioChallenge,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ bytes?: Buffer; reasonCode?: LocalCaptchaFailureCode }> {
    if (challenge.audioBytes) {
      if (!audioContentType(challenge.contentType ?? null)) {
        return { reasonCode: 'audio_unsupported_type' };
      }
      if (challenge.audioBytes.length === 0) return { reasonCode: 'audio_unavailable' };
      if (challenge.audioBytes.length > this.maxAudioBytes) return { reasonCode: 'audio_too_large' };
      return { bytes: challenge.audioBytes };
    }
    if (!this.fetchFn) return { reasonCode: 'audio_unavailable' };

    const remaining = remainingMs(deadline);
    if (remaining === 0) return { reasonCode: 'timeout' };
    try {
      const response = await this.fetchFn(challenge.audioUrl, { signal });
      if (!response.ok) return { reasonCode: 'audio_download_failed' };
      if (!audioContentType(response.headers.get('content-type'))) {
        return { reasonCode: 'audio_unsupported_type' };
      }
      return await readBoundedResponse(response, this.maxAudioBytes);
    } catch {
      return { reasonCode: signal.aborted ? 'audio_timeout' : 'audio_download_failed' };
    }
  }

  private async convertAudio(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<LocalCaptchaFailureCode | undefined> {
    const timeoutMs = Math.min(remainingMs(deadline), this.ffmpegTimeoutMs);
    if (timeoutMs === 0) return 'timeout';
    if (this.ffmpegRunner) return this.ffmpegRunner(inputPath, outputPath, { timeoutMs, signal });
    return this.spawnFfmpeg(inputPath, outputPath, { timeoutMs, signal });
  }

  private async spawnFfmpeg(
    inputPath: string,
    outputPath: string,
    options: FfmpegRunOptions,
  ): Promise<LocalCaptchaFailureCode | undefined> {
    let child: ChildProcess;
    try {
      const spawnOptions: SpawnOptions = {
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      };
      child = this.spawnFn(
        this.ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          inputPath,
          '-t',
          String(this.maxDurationSeconds),
          '-ac',
          '1',
          '-ar',
          '16000',
          '-f',
          's16le',
          outputPath,
        ],
        spawnOptions,
      );
    } catch {
      return 'ffmpeg_failed';
    }
    this.activeFfmpeg.add(child);
    let stderrBytes = 0;

    try {
      return await new Promise<LocalCaptchaFailureCode | undefined>((resolveRun) => {
        let settled = false;
        const finish = (reasonCode?: LocalCaptchaFailureCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          options.signal.removeEventListener('abort', onAbort);
          child.removeListener('error', onError);
          child.removeListener('close', onClose);
          child.stderr?.removeListener('data', onStderr);
          resolveRun(reasonCode);
        };
        const onError = () => finish('ffmpeg_failed');
        const onClose = (code: number | null) => finish(code === 0 ? undefined : 'ffmpeg_failed');
        const stop = (reasonCode: LocalCaptchaFailureCode) => {
          void terminateChildProcess(child, 500).finally(() => finish(reasonCode));
        };
        const onAbort = () => stop('cancelled');
        const timeout = setTimeout(() => stop('ffmpeg_timeout'), options.timeoutMs);
        child.once('error', onError);
        child.once('close', onClose);
        const onStderr = (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_FFMPEG_STDERR_BYTES) stop('ffmpeg_failed');
        };
        child.stderr?.on('data', onStderr);
        options.signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      this.activeFfmpeg.delete(child);
    }
  }

  private transcriptionOutcome(
    transcription: TranscriptionOutcome,
    startedAt: number,
  ): LocalCaptchaSolveOutcome {
    if (transcription.status === 'failure') {
      return failed(transcriberFailureCode(transcription.reasonCode), startedAt);
    }
    const answer = transcription.text
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!answer) return failed('empty_transcript', startedAt);
    if (answer.length > MAX_TRANSCRIPT_LENGTH) return failed('transcription_failed', startedAt);
    return { status: 'success', answer, durationMs: Math.max(0, Date.now() - startedAt) };
  }

  private waitForActiveAttempts(): Promise<void> {
    if (this.activeControllers.size === 0) return Promise.resolve();
    return new Promise((resolveIdle) => this.idleWaiters.add(resolveIdle));
  }

  private notifyIdleIfNeeded(): void {
    if (this.activeControllers.size !== 0) return;
    for (const resolveIdle of this.idleWaiters) resolveIdle();
    this.idleWaiters.clear();
  }

  private transcriberSnapshot():
    | {
        active: boolean;
        queued: boolean;
        workerRestartCount: number;
        circuitOpen: boolean;
        workerPid?: number;
      }
    | undefined {
    const candidate = this.transcriber as VoskTranscriberClient & {
      snapshot?: () => {
        active: boolean;
        queued: boolean;
        workerRestartCount: number;
        circuitOpen: boolean;
        workerPid?: number;
      };
    };
    return candidate.snapshot?.();
  }
}
