import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTargetScopedUncertain } from
  '../src/acquisition/collect-target-scoped-uncertain.mjs';
import { confirmMissingTargets } from
  '../src/acquisition/confirm-missing-targets.mjs';

const scope = { anidbId: 42, episodeIds: [1001], kind: 'series',
  publicLibraryIds: [102] };
const publicState = { state: 'healthy_unconfirmed', libraryIds: [102],
  parts: [], complete: false, probeCoverage: 'health_only',
  sourceVerified: true };
const providers = (overrides = {}) => ({
  ...scope, readEpisode: async (target) => ({ state: 'not_imported', ...target }),
  probePublic: async () => publicState, now: () => 100, ...overrides,
});

test('checks exact targets twice and returns without a global import wait', async () => {
  const calls = [];
  const result = await collectTargetScopedUncertain(providers({
    readEpisode: async (target) => { calls.push('shoko');
      return { state: 'not_imported', ...target }; },
    probePublic: async () => { calls.push('plex'); return publicState; },
  }));
  assert.deepEqual(calls, ['shoko', 'plex', 'shoko', 'plex']);
  assert.deepEqual(result, { anidbId: 42, episodeIds: [1001],
    observedAtMs: 100,
    shoko: { state: 'unimported_targets', anidbId: 42, episodeIds: [1001] },
    plex: publicState, importFence: { state: 'target_rechecked',
      anidbId: 42, episodeIds: [1001],
      beforeObservedAtMs: 100, afterObservedAtMs: 100 } });
  assert.deepEqual(await confirmMissingTargets({
    request: { id: 1, status: 'held', ...scope },
    episodeIds: [1001], publicLibraryIds: [102],
    firstTimePolicy: 'single_uncertain_attempt',
    readEvidence: async () => result, now: () => 101,
  }), { state: 'missing_confirmed', checkedAtMs: 101,
    observedAtMs: 100, evidencePolicy: 'first_time_permissive' });
});

test('a target appearing between checks blocks the attempt', async () => {
  let reads = 0;
  const result = await collectTargetScopedUncertain(providers({
    readEpisode: async (target) => ++reads === 1
      ? { state: 'not_imported', ...target }
      : { state: 'ok', complete: true, files: [{}] },
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'target_not_proven_unimported', episodeId: 1001 });
});

test('a failed public probe blocks the attempt', async () => {
  const result = await collectTargetScopedUncertain(providers({
    probePublic: async () => { throw Error('Plex unavailable'); },
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'availability_unavailable' });
});

test('provider outage provenance survives both first-time collectors', async () => {
  for (const readEpisode of [async () => ({ state: 'unavailable' }),
    async () => { throw Error('temporary Shoko outage'); }]) {
    assert.deepEqual(await collectTargetScopedUncertain(providers({ readEpisode })),
      { state: 'held', reason: 'availability_unavailable', episodeId: 1001 });
  }
  assert.deepEqual(await collectTargetScopedUncertain(providers({
    probePublic: async () => ({ state: 'held', reason: 'public_probe_unavailable' }),
  })), { state: 'held', reason: 'availability_unavailable' });
  assert.deepEqual(await collectTargetScopedUncertain(providers({
    probePublic: async () => ({ ...publicState, parts: [{ libraryId: 102 }] }),
  })), { state: 'held', reason: 'public_probe_unverified' },
  'a contradictory public observation is not classified as a transport outage');
});


test('checks a 24 episode pack in bounded parallel reads without self-expiring', async () => {
  let clock=1000,active=0,peak=0,scheduled=false;const pending=[];
  const wait=()=>new Promise(resolve=>{pending.push({at:clock+1500,resolve});if(!scheduled){scheduled=true;setImmediate(()=>{clock=Math.min(...pending.map(x=>x.at));const ready=pending.filter(x=>x.at===clock);for(const x of ready)pending.splice(pending.indexOf(x),1);scheduled=false;for(const x of ready)x.resolve();});}});
  const ids=Array.from({length:24},(_,i)=>1001+i);
  const result=await collectTargetScopedUncertain(providers({episodeIds:ids,now:()=>clock,
    readEpisode:async target=>{active++;peak=Math.max(peak,active);await wait();active--;return {state:'not_imported',...target};}}));
  assert.equal(result.state,undefined,JSON.stringify(result));
  assert.equal(result.shoko.state,'unimported_targets');
  assert.ok(peak>1&&peak<=4,'bounded parallelism must replace serial scans');
  assert.ok(clock-1000<30000);
  const confirmed=await confirmMissingTargets({request:{id:1,status:'held',...scope,episodeIds:ids},episodeIds:ids,publicLibraryIds:[102],firstTimePolicy:'single_uncertain_attempt',readEvidence:async()=>result,now:()=>clock});
  assert.equal(confirmed.state,'missing_confirmed');
});
