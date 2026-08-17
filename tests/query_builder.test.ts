import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueries, buildSearchText } from '../src/query_builder';
import { buildSiteSearchTexts } from '../src/platforms';

const CORE =
  '("Đà Nẵng" OR "Hội An" OR "Mỹ Khê" OR "Sơn Trà") "du lịch" -combo -booking -hotline -"liên hệ" -zalo -sđt -inbox -ib -tour -"báo giá"';

test('builds the exact NFC Da Nang Facebook query', () => {
  const [body] = buildSiteSearchTexts('facebook.com', 'da_nang');
  assert.equal(body, CORE);
  assert.equal(body, body.normalize('NFC'));

  const [query] = buildQueries(
    ['facebook.com'],
    body,
    '2026-06-25',
    '2026-06-25',
    0,
    'custom',
    'rolling',
  );
  assert.equal(
    query.query,
    `site:facebook.com ${CORE} -inurl:photo -inurl:photos after:2026-06-24`,
  );
});

test('adds platform-specific URL exclusions without changing the core', () => {
  assert.equal(
    buildSearchText('instagram.com', CORE),
    `${CORE} -inurl:explore -inurl:stories -inurl:accounts`,
  );
  assert.equal(
    buildSearchText('tiktok.com', CORE),
    `${CORE} -inurl:tag -inurl:discover -inurl:search -site:shop.tiktok.com`,
  );
});

test('bounded windows use exclusive after/before boundaries per day', () => {
  const [body] = buildSiteSearchTexts('facebook.com', 'da_nang');
  const queries = buildQueries(
    ['facebook.com'],
    body,
    '2026-06-24',
    '2026-06-25',
    1,
    'custom',
    'bounded',
  );

  assert.equal(queries.length, 2);
  assert.match(queries[0].query, /after:2026-06-23 before:2026-06-25$/);
  assert.match(queries[1].query, /after:2026-06-24 before:2026-06-26$/);
  assert.equal(queries[0].contentFrom, '2026-06-24');
  assert.equal(queries[1].contentTo, '2026-06-25');
});

test('tier aliases are capped A=4, B=3 and C=2', () => {
  assert.match(buildSiteSearchTexts('facebook.com', 'da_nang')[0], /^\("Đà Nẵng" OR "Hội An" OR "Mỹ Khê" OR "Sơn Trà"\)/);
  assert.match(buildSiteSearchTexts('facebook.com', 'hai_phong')[0], /^\("Hải Phòng" OR "Cát Bà" OR "Đồ Sơn"\)/);
  assert.match(buildSiteSearchTexts('facebook.com', 'lai_chau')[0], /^\("Lai Châu" OR "Pu Ta Leng"\)/);
});
