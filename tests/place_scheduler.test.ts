import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkPlaces, isDueToday, selectDuePlaces, windowFor } from '../src/place_scheduler';
import { CadenceSpec, PlaceEntry } from '../src/profiles/types';

const cadenceTable: Record<string, CadenceSpec> = {
  core: { cadenceDays: 4, windowDays: 8 },
  mid: { cadenceDays: 8, windowDays: 12 },
  long: { cadenceDays: 14, windowDays: 18 },
};

test('isDueToday schedules a cadence-4 chunk exactly once in four days', () => {
  const [chunk] = chunkPlaces([
    { name: 'Đà Nẵng', provinceSlug: 'da_nang', cadence: 'core' },
  ], 1);
  const start = new Date('2026-08-18T00:00:00.000Z');
  const dueDays = Array.from({ length: 4 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    return isDueToday(chunk, cadenceTable, day);
  });

  assert.equal(dueDays.filter(Boolean).length, 1);
});

test('chunkPlaces keeps province and cadence groups separate and honors perQuery', () => {
  const places: PlaceEntry[] = [
    { name: 'A1', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A2', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A3', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A-mid', provinceSlug: 'alpha', cadence: 'mid' },
    { name: 'B1', provinceSlug: 'beta', cadence: 'core' },
  ];

  const chunks = chunkPlaces(places, 2);

  assert.deepEqual(
    chunks.map((chunk) => chunk.places.map((place) => place.name)),
    [['A1', 'A2'], ['A3'], ['A-mid'], ['B1']],
  );
  for (const chunk of chunks) {
    assert.ok(chunk.places.length <= 2);
    assert.equal(new Set(chunk.places.map((place) => place.provinceSlug)).size, 1);
    assert.equal(new Set(chunk.places.map((place) => place.cadence)).size, 1);
    assert.equal(chunk.key, `${chunk.provinceSlug}|${chunk.cadence}|${chunk.index}`);
  }

  const largerChunks = chunkPlaces(places.slice(0, 3), 3);
  assert.deepEqual(largerChunks.map((chunk) => chunk.places.length), [3]);
});

test('selectDuePlaces filters complete chunks without splitting them', () => {
  const chunks = chunkPlaces([
    { name: 'A1', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A2', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A3', provinceSlug: 'alpha', cadence: 'core' },
    { name: 'A4', provinceSlug: 'alpha', cadence: 'core' },
  ], 2);
  const start = new Date('2026-08-18T00:00:00.000Z');
  const dueChunks = selectDuePlaces(chunks, cadenceTable, start);

  assert.ok(dueChunks.length > 0);
  assert.ok(dueChunks.every((chunk) => chunk.places.length === 2));
  assert.ok(dueChunks.every((chunk) => chunks.some((candidate) => candidate.key === chunk.key)));
});

test('chunkPlaces rejects zero and non-integer perQuery values', () => {
  assert.throws(() => chunkPlaces([], 0), /perQuery must be a positive integer/);
  assert.throws(() => chunkPlaces([], 1.5), /perQuery must be a positive integer/);
});

test('windowFor uses the selected chunk cadence and UTC date boundaries', () => {
  const [chunk] = chunkPlaces([
    { name: 'Đà Nẵng', provinceSlug: 'da_nang', cadence: 'mid' },
  ], 1);
  const today = new Date('2026-08-18T12:34:56.000Z');

  assert.deepEqual(windowFor(chunk, cadenceTable, today), {
    dateFrom: '2026-08-06',
    dateTo: '2026-08-18',
  });
});
