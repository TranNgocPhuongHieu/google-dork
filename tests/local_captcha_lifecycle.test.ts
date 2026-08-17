import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalCaptchaSolver } from '../src/local_captcha_solver';
import { TranscriptionOutcome, VoskTranscriberClient } from '../src/vosk_transcriber';

const AUDIO_URL = 'https://www.google.com/recaptcha/api2/payload?p=fixture';
const AUDIO_BYTES = Buffer.from('synthetic-audio');

class SuccessfulTranscriber implements VoskTranscriberClient {
  calls = 0;
  closed = false;

  async transcribe(): Promise<TranscriptionOutcome> {
    this.calls += 1;
    return { status: 'success', text: 'one two' };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function createRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'google-dork-captcha-lifecycle-'));
}

function capturedAudio() {
  return {
    audioUrl: AUDIO_URL,
    audioBytes: AUDIO_BYTES,
    contentType: 'audio/mpeg',
  };
}

test('50 synthetic local solves keep temp directories and request slots at zero', async () => {
  const root = await createRoot();
  const transcriber = new SuccessfulTranscriber();
  const solver = new LocalCaptchaSolver({
    ffmpegPath: '/usr/bin/ffmpeg',
    timeoutMs: 1_000,
    tempRoot: root,
    transcriber,
    ffmpegRunner: async (_input, output) => {
      await writeFile(output, Buffer.alloc(32_000));
      return undefined;
    },
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await solver.solveAudio(capturedAudio());
      assert.equal(result.status, 'success');
    }
    assert.equal(transcriber.calls, 50);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(solver.diagnostics(), {
      workerRestarts: 0,
      circuitOpen: false,
      activeChildren: 0,
      pendingRequests: 0,
      activeTempDirs: 0,
    });
  } finally {
    await solver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ten forced ffmpeg timeouts clean every attempt without starting a transcriber request', async () => {
  const root = await createRoot();
  const transcriber = new SuccessfulTranscriber();
  const solver = new LocalCaptchaSolver({
    ffmpegPath: '/usr/bin/ffmpeg',
    timeoutMs: 1_000,
    tempRoot: root,
    transcriber,
    ffmpegRunner: async () => 'ffmpeg_timeout',
  });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await solver.solveAudio(capturedAudio());
      assert.deepEqual(result.status === 'failure' ? result.reasonCode : undefined, 'ffmpeg_timeout');
    }
    assert.equal(transcriber.calls, 0);
    assert.deepEqual(await readdir(root), []);
    assert.equal(solver.diagnostics().activeTempDirs, 0);
  } finally {
    await solver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('close aborts a cooperative conversion and releases the temporary directory', async () => {
  const root = await createRoot();
  const transcriber = new SuccessfulTranscriber();
  let markConversionStarted: () => void = () => {};
  const conversionStarted = new Promise<void>((resolve) => {
    markConversionStarted = resolve;
  });
  const solver = new LocalCaptchaSolver({
    ffmpegPath: '/usr/bin/ffmpeg',
    timeoutMs: 10_000,
    tempRoot: root,
    transcriber,
    ffmpegRunner: async (_input, _output, { signal }) => {
      markConversionStarted();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      });
    },
  });
  try {
    const pending = solver.solveAudio(capturedAudio());
    await conversionStarted;
    await solver.close();
    const result = await pending;
    assert.deepEqual(result.status === 'failure' ? result.reasonCode : undefined, 'cancelled');
    assert.equal(transcriber.closed, true);
    assert.deepEqual(await readdir(root), []);
    assert.equal(solver.diagnostics().activeTempDirs, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
