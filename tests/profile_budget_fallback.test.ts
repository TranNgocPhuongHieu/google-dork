import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSiteSearchTexts,
  countQueryWords,
  fitPlaceGroupsToBudget,
  QUERY_WORD_BUDGET,
} from '../src/platforms';
import { viProfile } from '../src/profiles/vi';
import { PlaceEntry } from '../src/profiles/types';

const longPlaces: PlaceEntry[] = [
  { name: 'một hai ba bốn năm', provinceSlug: 'synthetic', cadence: 'core' },
  { name: 'sáu bảy tám chín mười', provinceSlug: 'synthetic', cadence: 'core' },
  { name: 'mười một mười hai mười ba mười bốn', provinceSlug: 'synthetic', cadence: 'core' },
];

test('over-budget literal chunks shrink 3 to 2 without dropping literal or negatives', () => {
  const groups = fitPlaceGroupsToBudget('facebook.com', 'vi', longPlaces);

  assert.deepEqual(groups?.map((group) => group.length), [2, 1]);

  const texts = buildSiteSearchTexts('facebook.com', 'synthetic', 'vi', longPlaces);
  assert.equal(texts.length, 2);
  for (const text of texts) {
    assert.match(text, /"du lịch"/);
    assert.match(text, /-inbox/);
    assert.ok(countQueryWords(`site:facebook.com ${text} after:2026-08-09 before:2026-08-12`) <= QUERY_WORD_BUDGET);
  }
});

test('a two-place literal chunk that still exceeds budget is dropped', () => {
  const tooLong: PlaceEntry[] = [
    { name: 'một hai ba bốn năm sáu bảy', provinceSlug: 'synthetic', cadence: 'core' },
    { name: 'tám chín mười mười một mười hai mười ba', provinceSlug: 'synthetic', cadence: 'core' },
  ];

  assert.equal(fitPlaceGroupsToBudget('facebook.com', 'vi', tooLong), null);
  assert.deepEqual(buildSiteSearchTexts('facebook.com', 'synthetic', 'vi', tooLong), []);
});

test('EN emits complete intent groups instead of splitting intent terms', () => {
  const places = viProfile.places.slice(0, 3).map((place) => ({ ...place }));
  const groups = fitPlaceGroupsToBudget('facebook.com', 'en', places);
  const texts = buildSiteSearchTexts('facebook.com', places[0].provinceSlug, 'en', places);

  assert.ok(groups);
  assert.equal(texts.length, groups.length * 3);
  for (const term of [
    'I stayed',
    'we stayed',
    'would recommend',
    'tourist trap',
  ]) {
    assert.ok(texts.some((text) => text.includes(term)), `missing intent term ${term}`);
  }
});
