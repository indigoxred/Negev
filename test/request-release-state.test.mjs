import assert from 'node:assert/strict';
import test from 'node:test';
import { requestReleaseState } from '../src/requests/submit-held-request.mjs';

const episode = { id: 1, number: 1, type: 'Episode', title: 'One',
  airDate: '2026-10-01' };
const detail = { state: 'details', anidbId: 42, kind: 'series',
  airDate: '2026-10-01', endDate: null, episodeCount: 2,
  episodes: [episode] };

test('request release state keeps an incomplete aired installment watching', () => {
  assert.equal(requestReleaseState(detail, '2026-11-08'), 'airing');
  assert.equal(requestReleaseState({ ...detail, endDate: '2026-10-15',
    episodeCount: 1 }, '2026-11-08'), 'completed');
  assert.equal(requestReleaseState({ ...detail, airDate: null },
    '2026-11-08'), 'unknown');
});

test('all stated and aired episodes complete a series without an end date', () => {
  assert.equal(requestReleaseState({ ...detail, episodeCount: 1 },
    '2026-11-08'), 'completed');
});
