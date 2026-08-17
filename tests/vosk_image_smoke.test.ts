import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { VoskTranscriber } from '../src/vosk_transcriber';

// The pinned Vosk model has two stable phonetic variants for the fixture's
// short "i/are no" segment; both preserve the expected digit sequence.
const EXPECTED_TRANSCRIPTS = new Set([
  'one zero zero zero one nine oh two i no zero one eight zero three',
  'one zero zero zero one nine oh two are no zero one eight zero three',
]);

test('verified Vosk image transcribes the pinned fixture under the runtime user', async (t) => {
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
  try {
    const result = await transcriber.transcribe(fixturePath);
    assert.equal(result.status, 'success');
    assert.ok(
      EXPECTED_TRANSCRIPTS.has(
        result.status === 'success' ? result.text.toLowerCase().replace(/\s+/g, ' ').trim() : '',
      ),
      'Vosk output must preserve the pinned fixture phrase',
    );
  } finally {
    await transcriber.close();
  }

  assert.deepEqual(transcriber.snapshot(), {
    active: false,
    queued: false,
    workerRestartCount: 0,
    circuitOpen: false,
    workerPid: undefined,
  });
});
