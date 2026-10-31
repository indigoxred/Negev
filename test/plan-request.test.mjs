import assert from 'node:assert/strict';
import test from 'node:test';
import { planRequest } from '../src/requests/plan-request.mjs';

const detail = { state: 'details', anidbId: 1234, kind: 'series', complete: true,
  total: 3, episodes: [
    { id: 1001, number: 1, type: 'Episode', airDate: '2026-10-01' },
    { id: 1002, number: 2, type: 'Episode', airDate: '2026-11-01' },
    { id: 1099, number: 1, type: 'Special' },
  ] };

test('airing whole installment stores current regular IDs and future monitoring', () => {
  assert.deepEqual(planRequest({ detail, releaseState: 'airing', scope: 'installment',
    today: '2026-10-31' }), {
    state: 'ready', anidbId: 1234, kind: 'series',
    episodeIds: [1001], monitorFuture: true,
  });
  assert.deepEqual(planRequest({ detail, releaseState: 'airing', scope: 'installment',
    today: '2026-09-30' }), { state: 'held', reason: 'no_aired_episodes' });
  assert.deepEqual(planRequest({ detail, releaseState: 'airing', scope: 'installment' }),
    { state: 'held', reason: 'invalid_current_date' });
});

test('completed installment and movie are one-time exact acquisitions', () => {
  assert.equal(planRequest({ detail, releaseState: 'completed', scope: 'installment' }).monitorFuture, false);
  const movie = { ...detail, kind: 'movie', total: 1, episodes: [detail.episodes[0]] };
  assert.deepEqual(planRequest({ detail: movie, releaseState: 'completed', scope: 'installment' }), {
    state: 'ready', anidbId: 1234, kind: 'movie', episodeIds: [1001], monitorFuture: false,
  });
});

test('explicit special selection never adds regular episodes or another installment', () => {
  assert.deepEqual(planRequest({ detail, releaseState: 'completed', scope: 'episodes', episodeIds: [1099] }), {
    state: 'ready', anidbId: 1234, kind: 'series', episodeIds: [1099], monitorFuture: false,
  });
});

test('unknown status, incomplete detail, duplicate and foreign IDs hold', () => {
  assert.deepEqual(planRequest({ detail, releaseState: 'unknown', scope: 'installment' }),
    { state: 'held', reason: 'release_state_unknown' });
  assert.deepEqual(planRequest({ detail: { ...detail, complete: false }, releaseState: 'airing', scope: 'installment' }),
    { state: 'held', reason: 'detail_incomplete' });
  assert.deepEqual(planRequest({ detail: { ...detail, anidbId: undefined }, releaseState: 'completed', scope: 'installment' }),
    { state: 'held', reason: 'detail_incomplete' });
  for (const ids of [[1001, 1001], [9999], [1001, 9999]]) {
    assert.deepEqual(planRequest({ detail, releaseState: 'completed', scope: 'episodes', episodeIds: ids }),
      { state: 'held', reason: 'invalid_episode_selection' });
  }
});

test('trailer-only targets and movie future monitoring hold', () => {
  const trailer = { ...detail, total: 1,
    episodes: [{ id: 1098, number: 1, type: 'Trailer' }] };
  assert.deepEqual(planRequest({ detail: trailer, releaseState: 'completed', scope: 'installment' }),
    { state: 'held', reason: 'detail_incomplete' });
  const movie = { ...detail, kind: 'movie', total: 1, episodes: [detail.episodes[0]] };
  assert.deepEqual(planRequest({ detail: movie, releaseState: 'airing', scope: 'installment' }),
    { state: 'held', reason: 'release_state_unknown' });
});
