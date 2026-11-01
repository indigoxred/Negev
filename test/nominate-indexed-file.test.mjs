import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { nominateIndexedFile } from '../src/availability/nominate-indexed-file.mjs';

const root = path.resolve('negev-mounted-media');
const file = { fileId: 11, updated: '2026-11-02T00:00:00Z',
  state: 'linked', pairs: [{ anidbId: 42, episodeId: 1001 }] };
const hint = { updated: file.updated, size: 5,
  sourcePaths: ['/pure/Anime/episode.mkv'], observedMs: 100 };
const inventory = { getFile: () => file, getFileHint: () => hint };
const base = { fileId: 11, inventory,
  shokoMount: { appRoot: '/pure', localRoot: root },
  publicLibraryIds: [102, 123],
  probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
  cardIndex: { lookupCardsByCandidateKey: ({ kind }) => ({ state: 'candidates',
    cards: kind === 'episode' ? [{ libraryId: 102, ratingKey: 500 }] :
      [{ libraryId: 123, ratingKey: 700 }] }) } };

test('one stored Shoko hint nominates bounded public cards without publishing availability', async () => {
  let probeCalls = 0;
  const result = await nominateIndexedFile({ ...base,
    probeImpl: async (input) => {
      probeCalls++;
      assert.deepEqual(input, { filePath: path.join(root, 'Anime', 'episode.mkv'),
        allowedRoot: root, expectedSize: 5 });
      return { state: 'candidate', candidateKey: '1:2:5' };
    } });
  assert.equal(probeCalls, 1);
  assert.deepEqual(result, { state: 'nominated', fileId: 11,
    pairs: file.pairs, cards: [
      { libraryId: 102, ratingKey: 500, kind: 'episode' },
      { libraryId: 123, ratingKey: 700, kind: 'movie' }],
    probes: 1 });
});

test('an empty or stale index is unknown, never evidence of missing media', async () => {
  const result = await nominateIndexedFile({ ...base,
    cardIndex: { lookupCardsByCandidateKey: () =>
      ({ state: 'candidates', cards: [] }) } });
  assert.deepEqual(result, { state: 'unknown', reason: 'no_indexed_candidate',
    probes: 1 });
});

test('bad hint, wrong mount, and over-budget card collisions hold without a false candidate', async () => {
  let probes = 0;
  const probeImpl = async () => { probes++; return { state: 'candidate',
    candidateKey: '1:2:5' }; };
  assert.deepEqual(await nominateIndexedFile({ ...base, probeImpl,
    inventory: { ...inventory, getFileHint: () => ({ ...hint,
      sourcePaths: ['/pure/../outside.mkv'] }) } }),
  { state: 'unknown', reason: 'file_hint_unverified', probes: 0 });
  assert.equal(probes, 0);
  assert.deepEqual(await nominateIndexedFile({ ...base, probeImpl,
    shokoMount: { appRoot: '/elsewhere', localRoot: root } }),
  { state: 'unknown', reason: 'path_mapping_failed', probes: 0 });
  assert.equal(probes, 0);
  const many = Array.from({ length: 11 }, (_, i) =>
    ({ libraryId: 102, ratingKey: 500 + i }));
  assert.deepEqual(await nominateIndexedFile({ ...base, probeImpl,
    cardIndex: { lookupCardsByCandidateKey: () =>
      ({ state: 'candidates', cards: many }) } }),
  { state: 'held', reason: 'candidate_budget_exceeded', probes: 1 });
});
