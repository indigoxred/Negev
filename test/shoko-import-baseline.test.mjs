import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyShokoImportBaseline } from
  '../src/availability/shoko-import-baseline.mjs';

const file = { ID: 17, Size: 1_000, SeriesIDs: [{ ID: 42 }],
  Locations: [{ ManagedFolderID: 1, RelativePath: 'show/01.mkv', IsAccessible: true }] };
const diskFiles = [
  { relativePath: 'show/01.mkv', size: 1_000 },
  { relativePath: 'show/release.nfo', size: 80 },
];

test('recognized videos and passive NFO files form a known Import baseline', () => {
  assert.deepEqual(classifyShokoImportBaseline({ diskFiles,
    shokoPage: { Total: 1, List: [file] }, managedFolderId: 1 }),
  { state: 'recognized_baseline', matchedVideos: 1, passiveFiles: 1 });
});

test('a new video, incomplete sidecar, or unlinked Shoko video holds the baseline', () => {
  for (const [files, page] of [
    [[...diskFiles, { relativePath: 'new/02.mkv', size: 2_000 }],
      { Total: 1, List: [file] }],
    [[...diskFiles, { relativePath: '.hash.parts', size: 50 }],
      { Total: 1, List: [file] }],
    [diskFiles, { Total: 1, List: [{ ...file, SeriesIDs: [] }] }],
    [diskFiles, { Total: 1, List: [{ ...file, Size: 999 }] }],
  ]) {
    assert.equal(classifyShokoImportBaseline({ diskFiles: files,
      shokoPage: page, managedFolderId: 1 }).state, 'held');
  }
});

test('incomplete pages, repeated IDs, and inaccessible locations fail closed', () => {
  for (const page of [
    { Total: 2, List: [file] },
    { Total: 2, List: [file, file] },
    { Total: 1, List: [{ ...file, Locations: [{ ...file.Locations[0],
      IsAccessible: false }] }] },
  ]) {
    assert.equal(classifyShokoImportBaseline({ diskFiles,
      shokoPage: page, managedFolderId: 1 }).state, 'held');
  }
});
