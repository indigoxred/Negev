import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCachedPositiveCoverage } from
  '../src/acquisition/verify-cached-positive-coverage.mjs';

const request = { anidbId: 42, kind: 'series',
  episodeIds: [1001, 1002] };
const cached = { verifiedTargets: 2, targetCount: 2,
  availableEpisodeIds: [1001, 1002] };

test('a deleted Shoko target loses its stale positive before search', async () => {
  const checked = await verifyCachedPositiveCoverage({ request, cached,
    readShoko: async ({ episodeId }) => episodeId === 1001
      ? { state: 'not_imported', anidbId: 42, episodeId }
      : { state: 'ok', complete: true, files: [{ fileId: 9 }] },
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 2,
    availableEpisodeIds: [1002] });
});

test('a live Shoko file also needs current Plex availability', async () => {
  const checked = await verifyCachedPositiveCoverage({ request,
    cached: { verifiedTargets: 1, targetCount: 2,
      availableEpisodeIds: [1001] },
    readShoko: async () => ({ state: 'ok', complete: true,
      files: [{ fileId: 9 }] }),
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 2,
    availableEpisodeIds: [1001] });
});

test('provider uncertainty cannot turn an old proof into permission to reacquire', async () => {
  const checked = await verifyCachedPositiveCoverage({ request, cached,
    readShoko: async () => ({ state: 'unavailable' }),
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { state: 'held',
    reason: 'availability_unverified' });
});
