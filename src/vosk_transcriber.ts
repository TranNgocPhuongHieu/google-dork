import { ChildProcess, ForkOptions, fork } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

export type TranscriptionFailureCode =
  | 'busy'
  | 'cancelled'
  | 'circuit_open'
  | 'empty_transcript'
  | 'shutdown'
  | 'timeout'
  | 'transcription_failed'
  | 'worker_crashed';

export type TranscriptionOutcome =
  | { status: 'success'; text: string }
  | { status: 'failure'; reasonCode: TranscriptionFailureCode };

export interface VoskTranscriberClient {
  transcribe(pcmPath: string, options?: TranscriptionRequestOptions): Promise<TranscriptionOutcome>;
  close(): Promise<void>;
}

export interface TranscriptionRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VoskTranscriberOptions {
  modelPath: string;
  libraryPath: string;
  workerPath?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxWorkerRestarts?: number;
  workerFactory?: VoskWorkerFactory;
}

export interface VoskTranscriberSnapshot {
  active: boolean;
  queued: boolean;
  workerRestartCount: number;
  circuitOpen: boolean;
  workerPid?: number;
}

export type VoskWorkerFactory = (
  workerPath: string,
  args: string[],
  options: ForkOptions,
) => ChildProcess;

interface PendingRequest {
  requestId: string;
  pcmPath: string;
  resolve: (outcome: TranscriptionOutcome) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface WorkerMessage {
  requestId?: unknown;
  ok?: unknown;
  text?: unknown;
  reasonCode?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_WORKER_RESTARTS = 2;

function failed(reasonCode: TranscriptionFailureCode): TranscriptionOutcome {
  return { status: 'failure', reasonCode };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function absolutePath(value: string, name: string): string {
  if (!value || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function defaultWorkerPath(): string {
  return resolve(__dirname, 'vosk_worker.js');
}

function defaultWorkerFactory(workerPath: string, args: string[], options: ForkOptions): ChildProcess {
  return fork(workerPath, args, options);
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return typeof value === 'object' && value !== null;
}

/**
 * Supervises a single isolated native Vosk process. At most one request runs
 * and one may wait, which prevents a stalled recognizer from growing memory.
 */
export class VoskTranscriber implements VoskTranscriberClient {
  private readonly modelPath: string;
  private readonly libraryPath: string;
  private readonly workerPath: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxWorkerRestarts: number;
  private readonly workerFactory: VoskWorkerFactory;
  private worker: ChildProcess | undefined;
  private active: PendingRequest | undefined;
  private queued: PendingRequest | undefined;
  private closing = false;
  private circuitOpen = false;
  private workerRestartCount = 0;
  private readonly expectedStops = new Set<ChildProcess>();

  constructor(options: VoskTranscriberOptions) {
    this.modelPath = absolutePath(options.modelPath, 'modelPath');
    this.libraryPath = absolutePath(options.libraryPath, 'libraryPath');
    this.workerPath = absolutePath(options.workerPath ?? defaultWorkerPath(), 'workerPath');
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.maxWorkerRestarts = positiveInteger(
      options.maxWorkerRestarts ?? DEFAULT_MAX_WORKER_RESTARTS,
      'maxWorkerRestarts',
    );
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
  }

  snapshot(): VoskTranscriberSnapshot {
    return {
      active: Boolean(this.active),
      queued: Boolean(this.queued),
      workerRestartCount: this.workerRestartCount,
      circuitOpen: this.circuitOpen,
      workerPid: this.worker?.pid,
    };
  }

  async transcribe(
    pcmPath: string,
    options: TranscriptionRequestOptions = {},
  ): Promise<TranscriptionOutcome> {
    if (!pcmPath || pcmPath.includes('\0') || !isAbsolute(pcmPath)) {
      return failed('transcription_failed');
    }
    if (this.closing) return failed('shutdown');
    if (this.circuitOpen) return failed('circuit_open');
    if (options.signal?.aborted) return failed('cancelled');

    const request: Omit<PendingRequest, 'resolve'> = {
      requestId: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      pcmPath: resolve(pcmPath),
      signal: options.signal,
    };
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.requestTimeoutMs, 'timeoutMs');

    return new Promise<TranscriptionOutcome>((resolveRequest) => {
      const pending: PendingRequest = { ...request, resolve: resolveRequest };
      pending.timeout = setTimeout(() => this.handleTimeout(pending), timeoutMs);
      if (pending.signal) {
        pending.onAbort = () => this.handleAbort(pending);
        pending.signal.addEventListener('abort', pending.onAbort, { once: true });
      }

      if (!this.active) {
        this.start(pending);
      } else if (!this.queued) {
        this.queued = pending;
      } else {
        this.settle(pending, failed('busy'));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.active) this.settle(this.active, failed('shutdown'));
    if (this.queued) this.settle(this.queued, failed('shutdown'));
    const worker = this.worker;
    if (worker) await this.stopWorker(worker);
  }

  private start(pending: PendingRequest): void {
    if (this.closing) {
      this.settle(pending, failed('shutdown'));
      return;
    }
    if (this.circuitOpen) {
      this.settle(pending, failed('circuit_open'));
      return;
    }
    this.active = pending;

    let worker: ChildProcess;
    try {
      worker = this.getOrStartWorker();
    } catch {
      this.settle(pending, failed('worker_crashed'));
      return;
    }

    try {
      if (!worker.connected || !worker.send({ requestId: pending.requestId, pcmPath: pending.pcmPath })) {
        this.settle(pending, failed('worker_crashed'));
        void this.stopWorker(worker);
      }
    } catch {
      this.settle(pending, failed('worker_crashed'));
      void this.stopWorker(worker);
    }
  }

  private getOrStartWorker(): ChildProcess {
    if (this.worker && this.worker.connected) return this.worker;

    const worker = this.workerFactory(this.workerPath, [this.modelPath, this.libraryPath], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    worker.on('message', (message: unknown) => this.handleMessage(worker, message));
    worker.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleWorkerExit(worker, code, signal);
    });
    worker.once('error', () => {
      // The exit handler releases the request and decides whether to reopen the circuit.
    });
    this.worker = worker;
    return worker;
  }

  private handleMessage(worker: ChildProcess, message: unknown): void {
    if (worker !== this.worker || !isWorkerMessage(message)) return;
    const pending = this.active;
    if (!pending || message.requestId !== pending.requestId || typeof message.ok !== 'boolean') return;

    if (message.ok && typeof message.text === 'string' && message.text.trim()) {
      this.settle(pending, { status: 'success', text: message.text.trim() });
      return;
    }
    this.settle(pending, failed(message.ok ? 'empty_transcript' : 'transcription_failed'));
  }

  private handleWorkerExit(worker: ChildProcess, _code: number | null, _signal: NodeJS.Signals | null): void {
    const expected = this.expectedStops.delete(worker) || this.closing;
    if (this.worker === worker) this.worker = undefined;

    if (this.active) {
      this.settle(this.active, failed(expected ? 'shutdown' : 'worker_crashed'));
    }
    if (!expected) {
      this.workerRestartCount += 1;
      if (this.workerRestartCount > this.maxWorkerRestarts) this.circuitOpen = true;
    }
    this.startNext();
  }

  private handleTimeout(pending: PendingRequest): void {
    if (!this.isPending(pending)) return;
    const wasActive = this.active === pending;
    this.settle(pending, failed('timeout'));
    if (wasActive && this.worker) void this.stopWorker(this.worker);
  }

  private handleAbort(pending: PendingRequest): void {
    if (!this.isPending(pending)) return;
    const wasActive = this.active === pending;
    this.settle(pending, failed('cancelled'));
    if (wasActive && this.worker) void this.stopWorker(this.worker);
  }

  private isPending(pending: PendingRequest): boolean {
    return this.active === pending || this.queued === pending;
  }

  private settle(pending: PendingRequest, outcome: TranscriptionOutcome): void {
    if (this.active === pending) this.active = undefined;
    if (this.queued === pending) this.queued = undefined;
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(outcome);
    this.startNext();
  }

  private startNext(): void {
    if (!this.active && this.queued) {
      const next = this.queued;
      this.queued = undefined;
      this.start(next);
    }
  }

  private async stopWorker(worker: ChildProcess): Promise<void> {
    if (this.expectedStops.has(worker)) return;
    this.expectedStops.add(worker);
    await terminateChildProcess(worker, this.shutdownTimeoutMs);
  }
}

export async function terminateChildProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolveStop) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      child.removeListener('exit', finish);
      resolveStop();
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // The process may already have exited or not own a separate group.
      }
      child.kill(signal);
    };
    const termTimer = setTimeout(() => kill('SIGTERM'), 0);
    const killTimer = setTimeout(() => {
      kill('SIGKILL');
      setTimeout(finish, Math.min(graceMs, 250));
    }, graceMs);
    child.once('exit', finish);
  });
}
