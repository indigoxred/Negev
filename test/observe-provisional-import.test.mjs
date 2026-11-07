import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { observeProvisionalImport, observeProvisionalPlacement } from '../src/acquisition/observe-provisional-import.mjs';

const evidence = evaluateHandoffEvidence({ identity: 'provisional',
  torrentHash: 'a'.repeat(40), anidbId: 42,
  files: [{ name: '05.mkv', size: 900, ed2k: 'A'.repeat(32),
    episodeIds: [1005] }], subtitles: [] });
const handoff = { status: 'published_observed', evidenceDigest: evidence.digest,
  manifest: evidence.manifest };
const unrecognized = { state: 'imported_unrecognized', fileId: 19711,
  ed2k: 'A'.repeat(32), size: 900 };
const recognized = { ...unrecognized, state: 'imported_recognized',
  release: { providerName: 'AniDB', id: 'anidb://sample',
    isCorrupted: false, crossReferences: [{ animeId: 42,
      episodeId: 1005, start: 0, end: 100 }] } };

test('Shoko may still be hashing after a provisional publish', async () => {
  assert.deepEqual(await observeProvisionalImport({ handoff,
    readImportedFile: async () => ({ state: 'not_imported' }) }),
  { state: 'awaiting_shoko' });
});

test('an exact imported file with no release waits for separate link evidence', async () => {
  let input;
  assert.deepEqual(await observeProvisionalImport({ handoff,
    readImportedFile: async (query) => { input = query; return unrecognized; } }),
  { state: 'awaiting_shoko_link', fileId: 19711 });
  assert.deepEqual(input, { ed2k: 'A'.repeat(32), size: 900 });
});

test('a later correct Shoko match records identity, not Plex availability', async () => {
  assert.deepEqual(await observeProvisionalImport({ handoff,
    readImportedFile: async () => recognized }),
  { state: 'shoko_files_identified', fileIds: [19711] });
});

test('conflicting, partial, or corrupt Shoko releases hold automatically', async () => {
  for (const release of [
    undefined,
    { ...recognized.release, crossReferences: [{ animeId: 42,
      episodeId: 1006, start: 0, end: 100 }] },
    { ...recognized.release, crossReferences: [{ animeId: 42,
      episodeId: 1005, start: 0, end: 50 }] },
    { ...recognized.release, isCorrupted: true },
  ]) {
    assert.deepEqual(await observeProvisionalImport({ handoff,
      readImportedFile: async () => ({ ...recognized, release }) }),
    { state: 'held', reason: 'shoko_identity_conflict' });
  }
});

test('damaged journal or changed Shoko hash cannot prove import', async () => {
  assert.deepEqual(await observeProvisionalImport({ handoff: {
    ...handoff, evidenceDigest: 'b'.repeat(64) },
  readImportedFile: async () => recognized }),
  { state: 'held', reason: 'handoff_evidence_mismatch' });
  assert.deepEqual(await observeProvisionalImport({ handoff,
    readImportedFile: async () => ({ ...unrecognized, size: 901 }) }),
  { state: 'held', reason: 'shoko_file_changed' });
});

test('provisional placement requires an accessible final-library path for the same file', async () => {
  const withLocations = { ...recognized, locations: [
    { managedFolderId: 2, path: '/pure/Anime/Show/05.mkv', accessible: true },
  ] };
  let query;
  assert.deepEqual(await observeProvisionalPlacement({ handoff,
    libraryRoot: '/pure/Anime', readImportedFile: async (value) => {
      query = value;
      return withLocations;
    } }), { state: 'shoko_library_location_reported', fileIds: [19711] });
  assert.equal(query.includeAbsolutePaths, true);
  for (const locations of [
    [{ managedFolderId: 2, path: '/pure/Anime-old/05.mkv', accessible: true }],
    [{ managedFolderId: 2, path: '/pure/Anime/Show/05.mkv', accessible: false }],
    [{ managedFolderId: 1, path: '/pure/Import/05.mkv', accessible: true }],
  ]) {
    assert.deepEqual(await observeProvisionalPlacement({ handoff,
      libraryRoot: '/pure/Anime', readImportedFile: async () =>
        ({ ...withLocations, locations }) }),
    { state: 'awaiting_shoko_placement', fileId: 19711 });
  }
});
