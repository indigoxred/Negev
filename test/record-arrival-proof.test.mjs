import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordArrivalProof } from
  '../src/availability/record-arrival-proof.mjs';

test('a new direct Plex card saves guarded file proof without waiting for a sweep', () => {
  const calls = [];
  const record = createRecordArrivalProof({
    inventory: { getFile: () => ({ state: 'linked',
      updated: '2026-11-12T00:00:00Z', observedMs: 90 }) },
    proofs: { observeGuarded: (input) => {
      calls.push(input); return { state: 'recorded' };
    }, getCurrent: () => ({ state: 'unknown' }) },
    cursor: { confirmRecentFile: () => ({ state: 'unchanged' }),
      prioritizeFile: () => { throw new Error('sweep must not be needed'); } },
    now: () => 101 });
  const target = { anidbId: 42, episodeId: 1001 };
  const proof = { fileId: 51, libraryId: 102, ratingKey: 500,
    partId: 600, storageKey: '1:2:5' };
  const cardRevision = { observedMs: 100, identitySignature: 'exact' };
  record(proof, target, { cardRevision });
  assert.deepEqual(calls, [{ ...target, proof,
    revision: { source: { updated: '2026-11-12T00:00:00Z',
      observedMs: 90 }, card: cardRevision }, checkedMs: 101 }]);
});

test('unindexed or changed sources keep their retry instead of saving unguarded proof', () => {
  const prioritized = [];
  const record = createRecordArrivalProof({
    inventory: { getFile: () => ({ state: 'linked', updated: 'bad',
      observedMs: 90 }) },
    proofs: { observeGuarded: () => ({ state: 'held',
      reason: 'source_generation_changed' }),
      getCurrent: () => ({ state: 'unknown' }) },
    cursor: { confirmRecentFile: () => ({ state: 'unchanged' }),
      prioritizeFile: (input) => prioritized.push(input) },
    now: () => 101 });
  record({ fileId: 51 }, { anidbId: 42, episodeId: 1001 });
  assert.deepEqual(prioritized, [{ fileId: 51, observedMs: 101 }]);
});

test('a composite arrival passes every source generation to the canonical recorder',()=>{let saved;const record=createRecordArrivalProof({inventory:{getFile:id=>({state:'linked',updated:'2026-11-23T00:00:00Z',observedMs:id})},proofs:{observeGuarded:x=>{saved=x;return{state:'recorded'}},getCurrent:()=>({state:'unknown'})},cursor:{confirmRecentFile:()=>({state:'unchanged'}),prioritizeFile:()=>{}},now:()=>100});const parts=[7,8].map((fileId,i)=>({fileId,libraryId:102,ratingKey:500,partId:600+i,mediaId:700,partIndex:i,partCount:2,storageKey:'1:'+(2+i)+':5'}));record({...parts[0],parts},{anidbId:42,episodeId:1001},{multipart:true,cardRevision:{observedMs:90,identitySignature:'exact'}});assert.deepEqual(saved.revision.sources,[{fileId:7,updated:'2026-11-23T00:00:00Z',observedMs:7},{fileId:8,updated:'2026-11-23T00:00:00Z',observedMs:8}]);});
