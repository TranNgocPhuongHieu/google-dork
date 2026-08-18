import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDorkTriggerPayload } from '../src/payload';

const basePayload = {
  job_id: 'profile-test',
  job_type: 'daily',
  search_sites: ['facebook.com'],
  date_from: '2026-03-01',
  date_to: '2026-03-02',
};

function parseWith(overrides: Record<string, unknown> = {}) {
  return parseDorkTriggerPayload({ ...basePayload, ...overrides });
}

test('defaults missing, null, and empty search_profile to vi_legacy', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing', {}],
    ['null', { search_profile: null }],
    ['empty', { search_profile: '' }],
  ];

  for (const [label, overrides] of cases) {
    const payload = parseWith(overrides);

    assert.equal(payload.search_profile, 'vi_legacy', label);
    assert.equal(payload.job_id, basePayload.job_id, label);
    assert.equal(payload.job_type, basePayload.job_type, label);
    assert.deepEqual(payload.search_sites, basePayload.search_sites, label);
    assert.equal(payload.date_from, basePayload.date_from, label);
    assert.equal(payload.date_to, basePayload.date_to, label);
  }
});

test('accepts the registered en search profile', () => {
  const payload = parseWith({ search_profile: 'en' });

  assert.equal(payload.search_profile, 'en');
});

test('lowercases a registered search profile', () => {
  const payload = parseWith({ search_profile: 'EN' });

  assert.equal(payload.search_profile, 'en');
});

test('rejects an unregistered search profile', () => {
  assert.throws(
    () => parseWith({ search_profile: 'xx' }),
    /search_profile must be a registered profile/,
  );
});
