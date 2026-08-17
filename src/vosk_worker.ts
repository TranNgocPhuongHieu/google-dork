import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

interface VoskApi {
  modelNew(modelPath: string): unknown;
  modelFree(model: unknown): void;
  recognizerNew(model: unknown, sampleRate: number): unknown;
  recognizerFree(recognizer: unknown): void;
  acceptWaveform(recognizer: unknown, pcm: Buffer, byteLength: number): number;
  finalResult(recognizer: unknown): string | null;
  close(): void;
}

interface KoffiLibrary {
  func(signature: string): (...args: never[]) => unknown;
  close(): void;
}

interface KoffiModule {
  load(libraryPath: string): KoffiLibrary;
}

interface WorkerRequest {
  requestId?: unknown;
  pcmPath?: unknown;
}

const SAMPLE_RATE_HZ = 16_000;
const localRequire = createRequire(__filename);
let api: VoskApi | undefined;
let model: unknown;
let shuttingDown = false;

function send(message: Record<string, unknown>): void {
  if (process.connected) process.send?.(message);
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !value.includes('\0') && isAbsolute(value);
}

function loadApi(libraryPath: string): VoskApi {
  // Koffi loads the library supplied by the immutable image; it never downloads native code.
  const koffi = localRequire('koffi') as KoffiModule;
  const library = koffi.load(libraryPath);
  return {
    modelNew: library.func('void * vosk_model_new(const char * model_path)') as VoskApi['modelNew'],
    modelFree: library.func('void vosk_model_free(void * model)') as VoskApi['modelFree'],
    recognizerNew: library.func(
      'void * vosk_recognizer_new(void * model, float sample_rate)',
    ) as VoskApi['recognizerNew'],
    recognizerFree: library.func(
      'void vosk_recognizer_free(void * recognizer)',
    ) as VoskApi['recognizerFree'],
    acceptWaveform: library.func(
      'int vosk_recognizer_accept_waveform(void * recognizer, const char * data, int length)',
    ) as VoskApi['acceptWaveform'],
    finalResult: library.func(
      'const char * vosk_recognizer_final_result(void * recognizer)',
    ) as VoskApi['finalResult'],
    close: () => library.close(),
  };
}

function parseTranscript(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

function transcribe(pcmPath: string): string {
  if (!api || !model) throw new Error('Vosk worker is not initialized');
  const recognizer = api.recognizerNew(model, SAMPLE_RATE_HZ);
  if (!recognizer) throw new Error('could not create Vosk recognizer');
  try {
    const pcm = readFileSync(pcmPath);
    if (pcm.length === 0) return '';
    api.acceptWaveform(recognizer, pcm, pcm.length);
    return parseTranscript(api.finalResult(recognizer));
  } finally {
    api.recognizerFree(recognizer);
  }
}

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (api && model) api.modelFree(model);
  model = undefined;
  api?.close();
  api = undefined;
}

function handleRequest(message: WorkerRequest): void {
  if (typeof message.requestId !== 'string' || !validPath(message.pcmPath)) return;
  try {
    const text = transcribe(message.pcmPath);
    send({ requestId: message.requestId, ok: true, text });
  } catch {
    send({ requestId: message.requestId, ok: false, reasonCode: 'transcription_failed' });
  }
}

function main(): void {
  const [modelPath, libraryPath] = process.argv.slice(2);
  if (!validPath(modelPath) || !validPath(libraryPath)) {
    throw new Error('Vosk worker requires absolute model and library paths');
  }
  api = loadApi(libraryPath);
  model = api.modelNew(modelPath);
  if (!model) throw new Error('could not load Vosk model');

  process.on('message', (message: WorkerRequest) => handleRequest(message));
  process.once('disconnect', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
}

try {
  main();
} catch {
  cleanup();
  process.exitCode = 1;
}
