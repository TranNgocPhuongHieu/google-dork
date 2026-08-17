import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { VoskTranscriber } from '../src/vosk_transcriber';

const EXPECTED_TRANSCRIPTS = new Set([
  'one zero zero zero one nine oh two i no zero one eight zero three',
  'one zero zero zero one nine oh two are no zero one eight zero three',
]);

function normalizeTranscript(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function processRssBytes(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

test('real Vosk worker survives a 50-request soak and shuts down without an orphan', async (t) => {
  const modelPath = process.env.CAPTCHA_VOSK_MODEL_PATH ?? '/opt/models/vosk';
  const libraryPath = process.env.CAPTCHA_VOSK_LIBRARY_PATH ?? '/opt/vosk/lib/libvosk.so';
  const fixturePath = join(__dirname, 'fixtures', 'vosk-api-test.wav');
  if (![modelPath, libraryPath, fixturePath].every(existsSync)) {
    t.skip('requires the final image model, library, and copied fixture');
    return;
  }

  const transcriber = new VoskTranscriber({
    modelPath,
    libraryPath,
    requestTimeoutMs: 60_000,
    shutdownTimeoutMs: 3_000,
  });
  let workerPid: number | undefined;
  try {
    const warmup = await transcriber.transcribe(fixturePath);
    assert.equal(warmup.status, 'success');
    assert.ok(
      EXPECTED_TRANSCRIPTS.has(warmup.status === 'success' ? normalizeTranscript(warmup.text) : ''),
      'warm-up output must preserve the pinned fixture phrase',
    );
    workerPid = transcriber.snapshot().workerPid;
    assert.ok(workerPid, 'worker remains available after warm-up');
    const warmRss = processRssBytes(workerPid!);

    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await transcriber.transcribe(fixturePath);
      assert.equal(result.status, 'success');
      assert.ok(
        EXPECTED_TRANSCRIPTS.has(result.status === 'success' ? normalizeTranscript(result.text) : ''),
        'soak output must preserve the pinned fixture phrase',
      );
      assert.equal(transcriber.snapshot().workerPid, workerPid);
    }

    const endRss = processRssBytes(workerPid!);
    if (warmRss !== undefined && endRss !== undefined) {
      const maximumGrowth = Math.max(Math.ceil(warmRss * 0.2), 150 * 1024 * 1024);
      assert.ok(endRss <= warmRss + maximumGrowth, `worker RSS grew from ${warmRss} to ${endRss}`);
    }
  } finally {
    const shutdownStarted = Date.now();
    await transcriber.close();
    assert.ok(Date.now() - shutdownStarted < 3_000, 'worker shutdown must fit its configured grace period');
  }

  assert.deepEqual(transcriber.snapshot(), {
    active: false,
    queued: false,
    workerRestartCount: 0,
    circuitOpen: false,
    workerPid: undefined,
  });
  if (workerPid) {
    assert.throws(() => process.kill(workerPid!, 0), { code: 'ESRCH' });
  }
});
