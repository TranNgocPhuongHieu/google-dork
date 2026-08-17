import test from 'node:test';
import assert from 'node:assert/strict';

test('logger emits HCM timestamps and a single-line job_received event', async () => {
  process.env.LOG_LEVEL = 'INFO';
  process.env.LOG_FORMAT = 'json';

  const { formatHcmIsoTimestamp, logJobReceived } = await import('../src/logger');

  assert.equal(
    formatHcmIsoTimestamp(new Date('2026-06-17T17:00:00.000Z')),
    '2026-06-18T00:00:00.000+07:00',
  );

  let output = '';
  const stdout = process.stdout as typeof process.stdout & {
    write: (...args: unknown[]) => boolean;
  };
  const originalWrite = stdout.write.bind(process.stdout);
  stdout.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') {
      output += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      output += chunk.toString('utf8');
    } else if (chunk !== undefined && chunk !== null) {
      output += String(chunk);
    }
    return true;
  }) as typeof stdout.write;

  try {
    logJobReceived('kafka_consumer', {
      job_id: 'job-1',
      job_type: 'daily',
      search_sites: ['facebook.com', 'x.com'],
      date_from: '2026-06-17',
      date_to: '2026-06-17',
      time_filter: 'past_24_hours',
      keyword_ids: [1, 2],
      split_days: 3,
    });
  } finally {
    stdout.write = originalWrite;
  }

  const lines = output.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.context, 'kafka_consumer');
  assert.equal(parsed.msg, 'job_received');
  assert.equal(parsed.timezone, 'Asia/Ho_Chi_Minh');
  assert.match(String(parsed.ts ?? ''), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+07:00$/);
  assert.deepEqual(parsed.search_sites, ['facebook.com', 'x.com']);
  assert.equal(parsed.keyword_ids_count, 2);
  assert.deepEqual(parsed.keyword_ids, [1, 2]);
});
