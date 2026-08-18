import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMaxPages } from '../src/page_depth';
import { PROFILES, SearchProfile } from '../src/profiles';

const profileIds = Object.keys(PROFILES) as SearchProfile[];
const legacyTierMaxPages = { A: 9, B: 6, C: 3 } as const;

test('registered profiles expose page-depth tables only when they are place-based', () => {
  for (const profileId of profileIds) {
    const profile = PROFILES[profileId];
    if (profile.useLegacyRegistry) {
      assert.equal(profile.pageDepth, undefined, `${profileId} must retain legacy page caps`);
      continue;
    }

    assert.deepEqual(profile.pageDepth, {
      A: { core: 5, mid: 3, long: 2 },
      B: { core: 2, mid: 2, long: 1 },
      C: { core: 1, mid: 1, long: 1 },
    });
  }
});

test('resolves tier and cadence page-depth caps for every place profile', () => {
  for (const profileId of profileIds) {
    const profile = PROFILES[profileId];
    if (profile.useLegacyRegistry) {
      assert.equal(
        resolveMaxPages(profile, 'A', undefined, {
          requestedMaxPages: 9,
          searchMaxPages: 9,
          legacyTierMaxPages,
        }),
        9,
      );
      assert.equal(
        resolveMaxPages(profile, 'B', undefined, {
          requestedMaxPages: 9,
          searchMaxPages: 9,
          legacyTierMaxPages,
        }),
        6,
      );
      assert.equal(
        resolveMaxPages(profile, 'C', undefined, {
          requestedMaxPages: 9,
          searchMaxPages: 9,
          legacyTierMaxPages,
        }),
        3,
      );
      continue;
    }

    assert.equal(
      resolveMaxPages(profile, 'A', 'core', {
        requestedMaxPages: 9,
        searchMaxPages: 9,
        legacyTierMaxPages,
      }),
      5,
    );
    assert.equal(
      resolveMaxPages(profile, 'A', 'mid', {
        requestedMaxPages: 9,
        searchMaxPages: 9,
        legacyTierMaxPages,
      }),
      3,
    );
    assert.equal(
      resolveMaxPages(profile, 'B', 'core', {
        requestedMaxPages: 9,
        searchMaxPages: 9,
        legacyTierMaxPages,
      }),
      2,
    );
    assert.equal(
      resolveMaxPages(profile, 'C', 'long', {
        requestedMaxPages: 9,
        searchMaxPages: 9,
        legacyTierMaxPages,
      }),
      1,
    );
  }
});

test('requested and global page caps still bound profile depth', () => {
  const profile = PROFILES.vi;
  assert.equal(
    resolveMaxPages(profile, 'A', 'core', {
      requestedMaxPages: 4,
      searchMaxPages: 4,
      legacyTierMaxPages,
    }),
    4,
  );
  assert.equal(
    resolveMaxPages(profile, 'A', 'core', {
      requestedMaxPages: 9,
      searchMaxPages: 3,
      legacyTierMaxPages,
    }),
    3,
  );
});
