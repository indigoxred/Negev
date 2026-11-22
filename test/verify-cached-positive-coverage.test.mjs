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
  assert.deepEqual(checked, { verifiedTargets: 0, targetCount: 2,
    availableEpisodeIds: [], uncertainEpisodeIds: [1001, 1002] });
});

test('one uncertain owned episode preserves other verified and independently missing targets', async () => {
  const checked = await verifyCachedPositiveCoverage({
    request: { ...request, episodeIds: [1001, 1002, 1003] },
    cached: { ...cached, targetCount: 3 },
    readShoko: async ({ episodeId }) => episodeId === 1001
      ? { state: 'unavailable' } : { state: 'ok', complete: true, files: [{ fileId: 9 }] },
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 3,
    availableEpisodeIds: [1002], uncertainEpisodeIds: [1001] });
});

test('bounded positive checks reuse unchanged targets and invalidate only a changed episode', async () => {
  const cache = new Map(), calls = [];
  let changed = false;
  const options = { request, cached, cache, maxChecks: 1,
    now: () => 100,
    readRevision: ({ episodeId }) => changed && episodeId === 1001 ? 'new' : 'old',
    readShoko: async ({ episodeId }) => { calls.push(episodeId);
      return { state: 'ok', complete: true, files: [{ fileId: episodeId }] }; },
    readPublic: async () => ({ state: 'available' }) };
  const first = await verifyCachedPositiveCoverage(options);
  assert.deepEqual(first.uncertainEpisodeIds, [1002]);
  assert.equal(first.verifiedTargets, 1);
  assert.equal((await verifyCachedPositiveCoverage(options)).verifiedTargets, 2);
  assert.equal((await verifyCachedPositiveCoverage(options)).verifiedTargets, 2);
  assert.deepEqual(calls, [1001, 1002]);
  changed = true;
  await verifyCachedPositiveCoverage(options);
  assert.deepEqual(calls, [1001, 1002, 1001]);
});

test('known Shoko ownership without a saved playable proof is protected when Plex is uncertain', async () => {
  const result = await verifyCachedPositiveCoverage({ request,
    cached: { targetCount: 2, verifiedTargets: 0, availableEpisodeIds: [] },
    ownedEpisodeIds: [1001],
    readShoko: async () => ({ state: 'ok', complete: true, files: [{ fileId: 9 }] }),
    readPublic: async () => ({ state: 'unknown' }) });
  assert.deepEqual(result.uncertainEpisodeIds, [1001]);
  assert.equal(result.verifiedTargets, 0);
});

test('a repeatedly unavailable target cannot starve uninspected owned episodes', async () => {
  let nowMs = 100;
  const calls = [], cache = new Map();
  const options = { request, cached, cache, maxChecks: 1, now: () => nowMs,
    readShoko: async ({ episodeId }) => { calls.push(episodeId);
      return episodeId === 1001 ? { state: 'unavailable' } :
        { state: 'ok', complete: true, files: [{ fileId: 9 }] }; },
    readPublic: async () => ({ state: 'available' }) };
  await verifyCachedPositiveCoverage(options);
  nowMs += 10_000;
  const result = await verifyCachedPositiveCoverage(options);
  assert.deepEqual(calls, [1001, 1002]);
  assert.deepEqual(result.availableEpisodeIds, [1002]);
  assert.deepEqual(result.uncertainEpisodeIds, [1001]);
});

test('only budget-deferred episodes request a continuation; actual uncertainty remains protected',async()=>{
 const cache=new Map();let clock=100;const options={request,cached,cache,maxChecks:1,now:()=>clock,readShoko:async({episodeId})=>episodeId===1001?{state:'unavailable'}:{state:'ok',complete:true,files:[{fileId:9}]},readPublic:async()=>({state:'available'})};
 const first=await verifyCachedPositiveCoverage(options);assert.deepEqual(first.pendingEpisodeIds,[1002]);assert.deepEqual(first.uncertainEpisodeIds,[1001,1002]);clock+=1000;
 const second=await verifyCachedPositiveCoverage(options);assert.equal(second.pendingEpisodeIds,undefined);assert.deepEqual(second.availableEpisodeIds,[1002]);assert.deepEqual(second.uncertainEpisodeIds,[1001]);
});
