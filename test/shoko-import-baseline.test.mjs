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

test('only an old, inactive, exactly owned qBittorrent parts sidecar is passive', () => {
  const hash = 'a'.repeat(40);
  const sidecarPath = `.${hash}.parts`;
  const withSidecar = [...diskFiles, { relativePath: sidecarPath, size: 500 }];
  const torrent = { hash, state: 'missingFiles', category: 'Direct',
    save_path: '/Shoko', progress: 0, dlspeed: 0, upspeed: 0,
    force_start: false, last_activity: 1_000 };
  const options = { diskFiles: withSidecar, shokoPage: { Total: 1, List: [file] },
    managedFolderId: 1, qbitImportSavePath: '/Shoko', nowMs: 4_700_000,
    sidecarTorrents: [{ relativePath: sidecarPath, torrent }] };
  assert.deepEqual(classifyShokoImportBaseline(options),
    { state: 'recognized_baseline', matchedVideos: 1, passiveFiles: 2 });
  for (const changed of [
    { state: 'downloading' }, { save_path: '/Downloads' },
    { dlspeed: 1 }, { last_activity: 4_000 },
    { hash: 'b'.repeat(40) }, { category: 'negev' },
  ]) {
    assert.equal(classifyShokoImportBaseline({ ...options,
      sidecarTorrents: [{ relativePath: sidecarPath,
        torrent: { ...torrent, ...changed } }] }).state, 'held');
  }
});
