import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTRY } from '../src/entity_registry';
import {
  buildSiteSearchTexts,
  countQueryWords,
  fitPlaceGroupsToBudget,
  normalizeSite,
  QUERY_WORD_BUDGET,
} from '../src/platforms';
import { buildSingleQuery } from '../src/query_builder';
import { chunkPlaces } from '../src/place_scheduler';
import { PROFILES, SearchProfile } from '../src/profiles';
import { PlaceEntry } from '../src/profiles/types';

const PROFILE_IDS = Object.keys(PROFILES) as SearchProfile[];
const CANONICAL_SITES = ['facebook.com', 'instagram.com', 'tiktok.com'] as const;
const DATE_FROM = '2026-08-10';
const DATE_TO = '2026-08-11';
const vi = PROFILES.vi;
const en = PROFILES.en;

function profileSlugs(profile: (typeof PROFILES)[SearchProfile]): string[] {
  return Array.from(new Set(profile.places.map((place) => place.provinceSlug)));
}

function fullQueryWordCount(site: string, searchText: string): number {
  return countQueryWords(buildSingleQuery(site, searchText, DATE_FROM, DATE_TO));
}

function siteCommercialNegatives(site: string): string[] {
  return vi.commercialNegativesBySite?.[site] ?? vi.commercialNegatives;
}

test('VI profile has 278 unique places with the required registry tier distribution', () => {
  assert.equal(vi.places.length, 278);

  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const place of vi.places) {
    const province = REGISTRY[place.provinceSlug];
    assert.ok(province, `VI place ${place.name} uses unknown provinceSlug=${place.provinceSlug}`);
    tierCounts[province.tier] += 1;
  }
  assert.deepEqual(tierCounts, { A: 216, B: 46, C: 16 });

  const names = vi.places.map((place) => place.name.normalize('NFC'));
  assert.equal(new Set(names).size, names.length, 'VI place names must be unique');
});

test('every place-based query stays within 32 words and does not drop a province', () => {
  for (const profileId of PROFILE_IDS) {
    const profile = PROFILES[profileId];
    const slugs = profile.useLegacyRegistry ? Object.keys(REGISTRY) : profileSlugs(profile);

    for (const site of CANONICAL_SITES) {
      const supported = profile.sites.some((candidate) => normalizeSite(candidate) === site);
      for (const slug of slugs) {
        const searchTexts = buildSiteSearchTexts(site, slug, profileId);
        if (!supported) {
          assert.deepEqual(searchTexts, [], `${profileId}/${site}/${slug} must be unsupported`);
          continue;
        }
        assert.ok(searchTexts.length > 0, `${profileId}/${site}/${slug} emitted no query`);

        // Legacy query text is a compatibility contract. Its historical
        // multi-word aliases can exceed the new budget on IG/TikTok.
        if (profile.useLegacyRegistry) continue;

        for (const searchText of searchTexts) {
          const words = fullQueryWordCount(site, searchText);
          assert.ok(
            words <= QUERY_WORD_BUDGET,
            `${profileId}/${site}/${slug} produced ${words} words: ${searchText}`,
          );
        }
      }
    }
  }
});

test('every profile place points to a known province slug', () => {
  for (const profileId of PROFILE_IDS) {
    for (const place of PROFILES[profileId].places) {
      assert.ok(
        Object.hasOwn(REGISTRY, place.provinceSlug),
        `${profileId} place ${place.name} uses unknown provinceSlug=${place.provinceSlug}`,
      );
    }
  }
});

test('VI keeps its literal and site-specific commercial negatives on all three sites', () => {
  assert.equal(vi.sites.length, 3);

  for (const site of vi.sites) {
    const negatives = siteCommercialNegatives(site);
    for (const slug of profileSlugs(vi)) {
      const searchTexts = buildSiteSearchTexts(site, slug, 'vi');
      assert.ok(searchTexts.length > 0, `VI dropped literal for ${site}/${slug}`);

      for (const searchText of searchTexts) {
        assert.match(searchText, /"du lịch"/, `VI literal missing from ${site}/${slug}`);
        for (const negative of negatives) {
          assert.ok(
            searchText.includes(negative),
            `VI negative ${JSON.stringify(negative)} missing from ${site}/${slug}`,
          );
        }
      }
    }
  }
});

test('VI falls back from three places to two without dropping literal or negatives', () => {
  const threePlaces: PlaceEntry[] = [
    { name: 'Alpha One Two Three', provinceSlug: 'ha_noi', cadence: 'core' },
    { name: 'Beta One Two Three', provinceSlug: 'ha_noi', cadence: 'core' },
    { name: 'Gamma One Two Three', provinceSlug: 'ha_noi', cadence: 'core' },
  ];

  for (const site of vi.sites) {
    const groups = fitPlaceGroupsToBudget(site, 'vi', threePlaces);
    if (!groups) assert.fail(`VI fallback dropped all places for ${site}`);
    assert.deepEqual(groups.map((group) => group.length), [2, 1]);

    const searchTexts = buildSiteSearchTexts(site, 'ha_noi', 'vi', threePlaces);
    assert.equal(searchTexts.length, 2, `VI fallback did not split 3 -> 2 for ${site}`);

    for (const searchText of searchTexts) {
      assert.match(searchText, /"du lịch"/);
      for (const negative of siteCommercialNegatives(site)) {
        assert.ok(searchText.includes(negative), `fallback lost negative ${JSON.stringify(negative)}`);
      }
      assert.ok(fullQueryWordCount(site, searchText) <= QUERY_WORD_BUDGET);
    }
  }
});

test('EN has exactly three intent groups and never splits an intent group', () => {
  const intentGroups: string[][] = en.intentGroups ?? [];
  if (intentGroups.length === 0) assert.fail('EN must define intent groups');
  assert.equal(intentGroups.length, 3);

  for (const site of en.sites) {
    for (const chunk of chunkPlaces(en.places, en.placesPerQuery)) {
      const searchTexts = buildSiteSearchTexts(site, chunk.provinceSlug, 'en', chunk.places);
      assert.equal(
        searchTexts.length,
        3,
        `EN emitted a split/drop for ${site}/${chunk.provinceSlug}/${chunk.key}`,
      );

      for (const [groupIndex, intentGroup] of intentGroups.entries()) {
        const matchingTexts = searchTexts.filter((searchText: string) =>
          intentGroup.every((term: string) => searchText.includes(term)),
        );
        assert.equal(
          matchingTexts.length,
          1,
          `EN intent group ${groupIndex} was split or dropped for ${chunk.key}`,
        );
      }
    }
  }
});

test('legacy profile omitted and explicit arguments are byte-identical', () => {
  assert.deepEqual(
    buildSiteSearchTexts('facebook.com', 'da_nang'),
    buildSiteSearchTexts('facebook.com', 'da_nang', 'vi_legacy'),
  );
});
