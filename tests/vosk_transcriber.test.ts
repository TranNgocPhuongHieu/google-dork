import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { VoskTranscriber } from '../src/vosk_transcriber';

class FakeWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 999_999;
  readonly sent: unknown[] = [];
  readonly kills: NodeJS.Signals[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return this.connected;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    this.connected = false;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  crash(): void {
    this.connected = false;
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
}

function createTranscriber(workers: FakeWorker[], maxWorkerRestarts = 2): VoskTranscriber {
  return new VoskTranscriber({
    modelPath: '/models/en',
    libraryPath: '/opt/vosk/libvosk.so',
    workerPath: '/workers/vosk_worker.js',
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
    maxWorkerRestarts,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as ChildProcess;
    },
  });
}

function requestId(worker: FakeWorker, index = 0): string {
  const request = worker.sent[index] as { requestId: string };
  return request.requestId;
}

test('transcriber sends only the generated PCM path and returns a structured transcript', async () => {
  const workers: FakeWorker[] = [];
  const transcriber = createTranscriber(workers);
  const pending = transcriber.transcribe('/tmp/challenge.pcm');

  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent[0], {
    requestId: requestId(workers[0]),
    pcmPath: '/tmp/challenge.pcm',
  });
  workers[0].emit('message', { requestId: requestId(workers[0]), ok: true, text: '  six seven  ' });

  assert.deepEqual(await pending, { status: 'success', text: 'six seven' });
  await transcriber.close();
});

test('transcriber bounds its queue to one active and one waiting request', async () => {
  const workers: FakeWorker[] = [];
  const transcriber = createTranscriber(workers);
  const first = transcriber.transcribe('/tmp/one.pcm');
  const second = transcriber.transcribe('/tmp/two.pcm');
  const third = transcriber.transcribe('/tmp/three.pcm');

  assert.deepEqual(await third, { status: 'failure', reasonCode: 'busy' });
  assert.equal(transcriber.snapshot().active, true);
  assert.equal(transcriber.snapshot().queued, true);

  workers[0].emit('message', { requestId: requestId(workers[0]), ok: true, text: 'one' });
  assert.deepEqual(await first, { status: 'success', text: 'one' });
  assert.equal(workers[0].sent.length, 2);
  workers[0].emit('message', { requestId: requestId(workers[0], 1), ok: true, text: 'two' });
  assert.deepEqual(await second, { status: 'success', text: 'two' });
  await transcriber.close();
});

test('request timeout terminates the isolated worker and does not leave a pending slot', async () => {
  const workers: FakeWorker[] = [];
  const transcriber = createTranscriber(workers);
  const result = await transcriber.transcribe('/tmp/hang.pcm', { timeoutMs: 15 });

  assert.deepEqual(result, { status: 'failure', reasonCode: 'timeout' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(workers[0].kills, ['SIGTERM']);
  assert.deepEqual(transcriber.snapshot(), {
    active: false,
    queued: false,
    workerRestartCount: 0,
    circuitOpen: false,
    workerPid: undefined,
  });
  await transcriber.close();
});

test('worker crashes are bounded by the circuit breaker', async () => {
  const workers: FakeWorker[] = [];
  const transcriber = createTranscriber(workers, 1);

  const first = transcriber.transcribe('/tmp/crash-one.pcm');
  workers[0].crash();
  assert.deepEqual(await first, { status: 'failure', reasonCode: 'worker_crashed' });

  const second = transcriber.transcribe('/tmp/crash-two.pcm');
  workers[1].crash();
  assert.deepEqual(await second, { status: 'failure', reasonCode: 'worker_crashed' });
  assert.equal(transcriber.snapshot().circuitOpen, true);
  assert.deepEqual(await transcriber.transcribe('/tmp/circuit.pcm'), {
    status: 'failure',
    reasonCode: 'circuit_open',
  });
  await transcriber.close();
});

test('ten forced worker crashes release every supervisor slot without an orphan worker reference', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const workers: FakeWorker[] = [];
    const transcriber = createTranscriber(workers);
    const pending = transcriber.transcribe(`/tmp/crash-${attempt}.pcm`);
    workers[0].crash();
    assert.deepEqual(await pending, { status: 'failure', reasonCode: 'worker_crashed' });
    await transcriber.close();
    assert.deepEqual(transcriber.snapshot(), {
      active: false,
      queued: false,
      workerRestartCount: 1,
      circuitOpen: false,
      workerPid: undefined,
    });
  }
});

test('close is idempotent and cancels both active and queued requests', async () => {
  const workers: FakeWorker[] = [];
  const transcriber = createTranscriber(workers);
  const active = transcriber.transcribe('/tmp/active.pcm');
  const queued = transcriber.transcribe('/tmp/queued.pcm');

  await Promise.all([transcriber.close(), transcriber.close()]);
  assert.deepEqual(await active, { status: 'failure', reasonCode: 'shutdown' });
  assert.deepEqual(await queued, { status: 'failure', reasonCode: 'shutdown' });
  assert.deepEqual(workers[0].kills, ['SIGTERM']);
});
