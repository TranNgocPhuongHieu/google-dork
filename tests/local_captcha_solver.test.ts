import assert from 'node:assert/strict';
import { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CaptchaTelemetryEvent,
  isRecaptchaAudioUrl,
  LocalCaptchaSolver,
} from '../src/local_captcha_solver';
import { TranscriptionOutcome, VoskTranscriberClient } from '../src/vosk_transcriber';

class FakeTranscriber implements VoskTranscriberClient {
  closed = false;
  next: TranscriptionOutcome = { status: 'success', text: 'seven two' };
  readonly paths: string[] = [];

  async transcribe(path: string): Promise<TranscriptionOutcome> {
    this.paths.push(path);
    return this.next;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFfmpegProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 999_998;
  readonly stderr = new EventEmitter();

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const AUDIO_URL = 'https://www.google.com/recaptcha/api2/payload?p=temporary';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'google-dork-local-captcha-test-'));
}

function audioResponse(body = Buffer.from('synthetic-audio')): Response {
  return new Response(body, { headers: { 'content-type': 'audio/mpeg' } });
}

test('only accepts HTTPS Google or recaptcha.net payload endpoints', () => {
  assert.equal(isRecaptchaAudioUrl(AUDIO_URL), true);
  assert.equal(isRecaptchaAudioUrl('https://recaptcha.net/recaptcha/enterprise/payload'), true);
  assert.equal(isRecaptchaAudioUrl('http://www.google.com/recaptcha/api2/payload'), false);
  assert.equal(isRecaptchaAudioUrl('https://google.com.evil.example/recaptcha/api2/payload'), false);
  assert.equal(isRecaptchaAudioUrl('https://www.google.com/recaptcha/api2/anchor'), false);
});

test('solver converts bounded audio, cleans its private files, and emits safe telemetry', async () => {
  const root = await tempRoot();
  const transcriber = new FakeTranscriber();
  const telemetry: CaptchaTelemetryEvent[] = [];
  try {
    const solver = new LocalCaptchaSolver({
      ffmpegPath: '/usr/bin/ffmpeg',
      timeoutMs: 1_000,
      tempRoot: root,
      transcriber,
      fetchFn: async () => audioResponse(),
      telemetry: (event) => telemetry.push(event),
      ffmpegRunner: async (_input, output) => {
        await writeFile(output, Buffer.alloc(320));
        return undefined;
      },
    });
    const result = await solver.solveAudio({ audioUrl: AUDIO_URL, proxyLabel: 'private_1' });

    assert.equal(result.status, 'success');
    assert.equal(result.status === 'success' ? result.answer : '', 'seven two');
    assert.equal(transcriber.paths.length, 1);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(
      telemetry.map((event) => event.event),
      ['captcha_audio_offered', 'captcha_local_attempt', 'captcha_local_result'],
    );
    assert.deepEqual(telemetry.at(-1), {
      event: 'captcha_local_result',
      proxyLabel: 'private_1',
      status: 'success',
      durationMs: result.durationMs,
    });
    assert.deepEqual(solver.diagnostics(), {
      workerRestarts: 0,
      circuitOpen: false,
      activeChildren: 0,
      pendingRequests: 0,
      activeTempDirs: 0,
    });
    await solver.close();
    assert.equal(transcriber.closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('solver rejects deceptive URLs before fetching or creating a temp file', async () => {
  const root = await tempRoot();
  let fetchCalls = 0;
  try {
    const solver = new LocalCaptchaSolver({
      ffmpegPath: '/usr/bin/ffmpeg',
      timeoutMs: 1_000,
      tempRoot: root,
      transcriber: new FakeTranscriber(),
      fetchFn: async () => {
        fetchCalls += 1;
        return audioResponse();
      },
    });
    const result = await solver.solveAudio({
      audioUrl: 'https://google.com.evil.example/recaptcha/api2/payload',
      proxyLabel: 'user:password@host',
    });

    assert.deepEqual(result.status === 'failure' ? result.reasonCode : undefined, 'invalid_audio_url');
    assert.equal(fetchCalls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('solver uses Page-captured audio bytes without issuing a second network request', async () => {
  const root = await tempRoot();
  try {
    const solver = new LocalCaptchaSolver({
      ffmpegPath: '/usr/bin/ffmpeg',
      timeoutMs: 1_000,
      tempRoot: root,
      transcriber: new FakeTranscriber(),
      ffmpegRunner: async (_input, output) => {
        await writeFile(output, Buffer.alloc(320));
        return undefined;
      },
    });
    const result = await solver.solveAudio({
      audioUrl: AUDIO_URL,
      audioBytes: Buffer.from('captured-in-page'),
      contentType: 'audio/mpeg',
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('solver returns a stable ffmpeg failure and removes temporary files', async () => {
  const root = await tempRoot();
  try {
    const solver = new LocalCaptchaSolver({
      ffmpegPath: '/usr/bin/ffmpeg',
      timeoutMs: 1_000,
      tempRoot: root,
      transcriber: new FakeTranscriber(),
      fetchFn: async () => audioResponse(),
      ffmpegRunner: async () => 'ffmpeg_failed',
    });
    const result = await solver.solveAudio({ audioUrl: AUDIO_URL });

    assert.deepEqual(result.status === 'failure' ? result.reasonCode : undefined, 'ffmpeg_failed');
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default ffmpeg runner uses argv with shell disabled and no network URL argument', async () => {
  const root = await tempRoot();
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  try {
    const solver = new LocalCaptchaSolver({
      ffmpegPath: '/usr/bin/ffmpeg',
      timeoutMs: 1_000,
      tempRoot: root,
      transcriber: new FakeTranscriber(),
      fetchFn: async () => audioResponse(),
      spawnFn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        calls.push({ command, args, options });
        const child = new FakeFfmpegProcess();
        queueMicrotask(async () => {
          await writeFile(args.at(-1)!, Buffer.alloc(320));
          child.emit('close', 0, null);
        });
        return child as unknown as ChildProcess;
      }) as typeof import('node:child_process').spawn,
    });
    const result = await solver.solveAudio({ audioUrl: AUDIO_URL });

    assert.equal(result.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/ffmpeg');
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].args.includes(AUDIO_URL), false);
    assert.equal(calls[0].args.includes('-nostdin'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
