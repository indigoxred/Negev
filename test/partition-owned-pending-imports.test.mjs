import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { partitionOwnedPendingImports } from
  '../src/availability/partition-owned-pending-imports.mjs';

const ed2k = 'A'.repeat(32);
const manifestEvidence = evaluateHandoffEvidence({ anidbId: 42,
  torrentHash: 'b'.repeat(40),
  files: [{ name: 'Show/01.mkv', size: 1000, ed2k,
    anidbFileId: 801, episodeIds: [1001] }], subtitles: [] });
const publishName = `negev-7-${manifestEvidence.digest.slice(0, 16)}`;
const pendingPath = `${publishName}/Show/01.mkv`;
const handoff = { status: 'published_observed', publishName,
  evidenceDigest: manifestEvidence.digest, manifest: manifestEvidence.manifest };
const diskFiles = [{ relativePath: pendingPath, size: 1000 }];
const file = { ID: 51, Size: 1000, SeriesIDs: [],
  Hashes: [{ Type: 'ED2K', Value: ed2k }],
  Locations: [{ ManagedFolderID: 1, RelativePath: pendingPath,
    IsAccessible: true }] };
const shokoPage = { Total: 1, List: [file] };
const options = { diskFiles, shokoPage, managedFolderId: 1,
  getHandoff: (id) => id === 7 ? handoff : null };

test('exact Negev-published pending file is attributable to another target', () => {
  assert.deepEqual(partitionOwnedPendingImports({ ...options,
    target: { anidbId: 43, episodeIds: [2001] } }), {
    state: 'partitioned', diskFiles: [], shokoPage: { Total: 0, List: [] },
    unrelatedPending: 1, unrelatedPendingKeys: [`1:${pendingPath}`],
  });
});

test('Shoko ED2K letter case does not change exact pending attribution', () => {
  const lowerHash = { ...file, Hashes: [{ Type: 'ED2K', Value: ed2k.toLowerCase() }] };
  assert.equal(partitionOwnedPendingImports({ ...options,
    shokoPage: { Total: 1, List: [lowerHash] },
    target: { anidbId: 43, episodeIds: [2001] } }).state, 'partitioned');
  assert.equal(partitionOwnedPendingImports({ ...options,
    shokoPage: { Total: 1, List: [{ ...lowerHash,
      Hashes: [{ Type: 'ED2K', Value: 'B'.repeat(32) }] }] },
    target: { anidbId: 43, episodeIds: [2001] } }).state, 'held');
});

test('a pending file for the requested target remains held', () => {
  assert.deepEqual(partitionOwnedPendingImports({ ...options,
    target: { anidbId: 42, episodeIds: [1001] } }),
  { state: 'held', reason: 'target_pending_import' });
});

test('missing hash, changed size, extra file and unproved publish all hold', () => {
  for (const change of [
    { shokoPage: { Total: 1, List: [{ ...file, Hashes: [] }] } },
    { diskFiles: [{ relativePath: pendingPath, size: 999 }] },
    { diskFiles: [...diskFiles,
      { relativePath: `${publishName}/other.mkv`, size: 10 }] },
    { getHandoff: () => ({ ...handoff, status: 'publish_unknown' }) },
    { getHandoff: () => null },
    { shokoPage: { Total: 0, List: [] } },
  ]) assert.equal(partitionOwnedPendingImports({ ...options, ...change,
    target: { anidbId: 43, episodeIds: [2001] } }).state, 'held');
});
