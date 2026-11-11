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
