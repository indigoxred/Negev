import assert from 'node:assert/strict';
import test from 'node:test';
import { inferReleaseState } from '../src/catalogue/infer-release-state.mjs';

const base = { today: '2026-10-31', kind: 'series', airDate: '2026-10-01',
  endDate: null, episodeCount: 12, episodes: [
    { type: 'Episode', airDate: '2026-10-01' },
    { type: 'Episode', airDate: '2026-11-01' },
  ] };

test('ongoing series is inferred airing and a passed end date completes it', () => {
  assert.deepEqual(inferReleaseState(base), { state: 'airing', confidence: 'inferred' });
  assert.deepEqual(inferReleaseState({ ...base, endDate: '2026-10-20',
    episodes: [{ type: 'Episode', airDate: '2026-10-01' }] }),
    { state: 'completed', confidence: 'inferred' });
  assert.deepEqual(inferReleaseState({ ...base, endDate: '2026-12' }),
    { state: 'airing', confidence: 'inferred' });
});

test('partial dates use their last possible day and future starts remain upcoming', () => {
  assert.equal(inferReleaseState({ ...base, airDate: '2026-10' }).state, 'airing');
  assert.equal(inferReleaseState({ ...base, airDate: '2026-11' }).state, 'upcoming');
  assert.equal(inferReleaseState({ ...base, airDate: '2026' }).state, 'upcoming');
  assert.equal(inferReleaseState({ ...base, airDate: '2025' }).state, 'airing');
});

test('a started movie or all expected regular episodes aired is completed', () => {
  assert.equal(inferReleaseState({ ...base, kind: 'movie' }).state, 'completed');
  assert.equal(inferReleaseState({ ...base, episodeCount: 1, episodes: base.episodes.slice(0, 1) }).state, 'completed');
  assert.equal(inferReleaseState({ ...base, episodeCount: 2, episodes: [
    { type: 'Episode', airDate: '2026-10-01' },
    { type: 'Episode', airDate: '2026-10-30' },
  ] }).state, 'completed');
});

test('missing start, impossible dates and contradictory date order remain unknown', () => {
  for (const input of [
    { ...base, airDate: null },
    { ...base, airDate: '2026-02-30' },
    { ...base, endDate: '2026-09-01' },
    { ...base, endDate: '2026-10-20', episodes: [
      { type: 'Episode', airDate: '2026-11-01' }] },
    { ...base, today: 'not-a-date' },
  ]) assert.deepEqual(inferReleaseState(input), { state: 'unknown', confidence: 'none' });
});
