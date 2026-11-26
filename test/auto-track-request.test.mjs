import assert from 'node:assert/strict';
import test from 'node:test';
import { autoTrackSavedAiringRequest } from '../src/web/auto-track-request.mjs';

test('only a saved airing series owned by the requester enters tracking', () => {
  let preferences = { mode: 'custom', trackedAnidbIds: [5] };
  const accounts = {
    getAiringPreferences: () => preferences,
    changeAiringPreferences: ({ action, anidbId }) => {
      assert.equal(action, 'track');
      preferences = { ...preferences,
        trackedAnidbIds: [...new Set([...preferences.trackedAnidbIds, anidbId])] };
      return preferences;
    },
  };
  const request = { requesterId: 2, anidbId: 8, kind: 'series',
    monitorFuture: true, status: 'held' };
  const input = { result: { requestId: 7, created: true }, requesterId: 2, anidbId: 8,
    readRequest: () => request, accounts };
  autoTrackSavedAiringRequest(input);
  autoTrackSavedAiringRequest(input);
  assert.deepEqual(preferences, { mode: 'custom', trackedAnidbIds: [5, 8] });
  for (const change of [{ requesterId: 3 }, { anidbId: 9 },
    { kind: 'movie' }, { monitorFuture: false }, { status: 'cancelled' }]) {
    autoTrackSavedAiringRequest({ ...input, anidbId: 12,
      readRequest: () => ({ ...request, ...change, anidbId: change.anidbId ?? 12 }) });
  }
  assert.deepEqual(preferences.trackedAnidbIds, [5, 8]);
});
