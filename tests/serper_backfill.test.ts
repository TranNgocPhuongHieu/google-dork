import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildQueries } from '../src/query_builder';
import { buildSiteSearchTexts } from '../src/platforms';
import { EN_PLACES } from '../src/profiles/en';
import {
  BackfillChunk,
  CheckpointStore,
  SerperKeyPool,
  adaptiveHasNextPage,
  buildBackfillQuery,
  parseSerperOrganic,
  selectNextKey,
  splitBackfillRange,
  validatePacingMs,
} from '../src/serper_en_backfill';

test('buildBackfillQuery matches the production EN body and date bounds', () => {
  const places = EN_PLACES.filter((place) => place.provinceSlug === 'da_nang').slice(0, 3);
  const chunk: BackfillChunk = {
    key: 'da_nang|core|0',
    provinceSlug: 'da_nang',
    cadence: 'core',
    index: 0,
    tier: 'A',
    places,
  };
  const window = splitBackfillRange('2026-01-01', '2026-01-14', 14)[0];
  const [body] = buildSiteSearchTexts('facebook.com', 'da_nang', 'en', places);
  const expected = buildQueries(
    ['facebook.com'],
    body,
    window.dateFrom,
    window.dateTo,
    0,
    'custom',
    'bounded',
  )[0].query;

  assert.equal(buildBackfillQuery('facebook.com', chunk, 0, window), expected);
  assert.match(expected, /after:2025-12-31 before:2026-01-15$/);
});

test('splitBackfillRange uses fourteen-day windows with one-day overlap and a short tail', () => {
  const windows = splitBackfillRange('2026-01-01', '2026-02-01', 14);

  assert.deepEqual(windows, [
    {
      index: 0,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-14',
      queryAfter: '2025-12-31',
      queryBefore: '2026-01-15',
    },
    {
      index: 1,
      dateFrom: '2026-01-14',
      dateTo: '2026-01-27',
      queryAfter: '2026-01-13',
      queryBefore: '2026-01-28',
    },
    {
      index: 2,
      dateFrom: '2026-01-27',
      dateTo: '2026-02-01',
      queryAfter: '2026-01-26',
      queryBefore: '2026-02-02',
    },
  ]);
});

test('adaptiveHasNextPage respects the result threshold and page maximum', () => {
  assert.equal(adaptiveHasNextPage(8, 1, 3, 8), true);
  assert.equal(adaptiveHasNextPage(10, 2, 3, 8), true);
  assert.equal(adaptiveHasNextPage(10, 3, 3, 8), false);
  assert.equal(adaptiveHasNextPage(7, 1, 3, 8), false);
  assert.equal(adaptiveHasNextPage(8, 1, 1, 8), false);
});

test('selectNextKey round-robins past exhausted keys', () => {
  const states: {
    raw: string;
    label: string;
    usage: number;
    status: 'alive' | 'exhausted' | 'limit';
  }[] = [
    { raw: 'secret-a', label: 'key_1', usage: 0, status: 'alive' },
    { raw: 'secret-b', label: 'key_2', usage: 0, status: 'alive' },
  ];

  const first = selectNextKey(states, 0);
  assert.equal(first?.state.label, 'key_1');
  assert.equal(first?.nextCursor, 1);

  states[0].status = 'exhausted';
  const second = selectNextKey(states, first?.nextCursor ?? 0);
  assert.equal(second?.state.label, 'key_2');
  assert.equal(second?.nextCursor, 0);

  states[1].status = 'exhausted';
  assert.equal(selectNextKey(states, 0), null);
});

test('SerperKeyPool hard-stops at the shared credit limit', () => {
  const pool = new SerperKeyPool(['secret-a', 'secret-b'], 10, 2);
  const first = pool.acquire();
  pool.recordRequest(first);
  const second = pool.acquire();
  pool.recordRequest(second);

  assert.throws(() => pool.acquire(), /Serper credit limit reached/);
});

test('CheckpointStore reopens a completed item for resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'serper-backfill-test-'));
  const file = join(directory, 'checkpoint.json');

  try {
    const store = await CheckpointStore.open(file, 'fingerprint-1', true);
    await store.markDone('item-1', {
      itemId: 'item-1',
      page: 3,
      requests: 1,
      credit: 1,
      rawOrganic: 8,
      eligible: 2,
      inserted: 2,
      duplicate: 0,
      organicCount: 8,
      hasNext: false,
    });

    const resumed = await CheckpointStore.open(file, 'fingerprint-1', true);
    assert.equal(resumed.doneCount, 1);
    assert.equal(resumed.entries['item-1']?.page, 3);
    assert.equal(resumed.entries['item-1']?.status, 'done');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parseSerperOrganic treats a missing organic field as an empty result set', () => {
  assert.deepEqual(parseSerperOrganic({}), []);
  assert.deepEqual(
    parseSerperOrganic({
      organic: [
        { link: 'https://example.test/a', title: 'A', snippet: 'Snippet A' },
        { title: 'missing link' },
        { link: '' },
      ],
    }),
    [{ link: 'https://example.test/a', title: 'A', snippet: 'Snippet A' }],
  );
});

test('validatePacingMs rejects a pacing interval below ten milliseconds', () => {
  assert.throws(() => validatePacingMs(9), /10/);
  assert.equal(validatePacingMs(10), 10);
  assert.equal(validatePacingMs(25), 25);
});

test('SerperClient sends the fixed request body and switches keys once after a 403', async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const responses = [
    new Response('', { status: 403 }),
    new Response(
      JSON.stringify({
        organic: [{ link: 'https://example.test/post', title: 'Post', snippet: 'Snippet' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  ];
  const pool = new SerperKeyPool(['key-one', 'key-two'], 10, 10);
  const { SerperClient } = await import('../src/serper_en_backfill');
  const client = new SerperClient(pool, 10, {
    now: () => 0,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('unexpected extra request');
      return response;
    },
  });

  const query = 'site:facebook.com ("Da Nang") ("I stayed")';
  const result = await client.search(query, 2);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    JSON.parse(String(calls[0].init?.body)),
    { q: query, gl: 'vn', hl: 'vi', page: 2 },
  );
  assert.deepEqual(
    JSON.parse(String(calls[1].init?.body)),
    { q: query, gl: 'vn', hl: 'vi', page: 2 },
  );
  assert.doesNotMatch(String(calls[0].init?.body), /"num"/);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)['X-API-KEY'],
    'key-one',
  );
  assert.equal(
    (calls[1].init?.headers as Record<string, string>)['X-API-KEY'],
    'key-two',
  );
  assert.equal(result.stats.requests, 2);
  assert.equal(result.stats.credit, 2);
  assert.equal(result.organic.length, 1);
  assert.deepEqual(pool.snapshot().keys, [
    { key: 'key_1', usage: 1, status: 'exhausted' },
    { key: 'key_2', usage: 1, status: 'alive' },
  ]);
  assert.deepEqual(sleeps, [10]);
});
