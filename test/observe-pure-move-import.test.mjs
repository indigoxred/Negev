import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observePureMoveImport } from '../src/acquisition/observe-pure-move-import.mjs';

const move = { status: 'published_observed', manifest: {
  files: [{ name: 'Movie.mkv', size: 100, dev: '12', ino: '34',
    mtimeNs: '56', episodeIds: [901] }],
} };
const target = { anidbId: 500, episodeIds: [901] };
const shokoMount = { appRoot: '/pure', localRoot: process.platform === 'win32'
  ? 'C:\\pure' : '/pure' };
const file = { fileId: 77, anidbId: 500, episodeIds: [901],
  coverage: [{ episodeId: 901, start: 0, end: 100 }], size: 100,
  releaseEvidence: 'shoko_offline_link',
  sourcePaths: ['/pure/Anime/Movie.mkv'] };

test('associates only the exact journalled inode with the Shoko identity', async () => {
  const result = await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => ({ state: 'ok', complete: true, files: [file] }),
    probeImpl: async () => ({ state: 'candidate', candidateKey: '12:34:100:56' }),
  });
  assert.deepEqual(result, { state: 'shoko_files_identified',
    files: [{ name: 'Movie.mkv', fileId: 77,
      releaseEvidence: 'shoko_offline_link' }] });
});

test('registered provenance requires Shoko to supply an AniDB file ID', async () => {
  const readEpisode = async (value) => ({ state: 'ok', complete: true,
    files: [{ ...file, releaseEvidence: undefined, anidbFileId: value }] });
  const probeImpl = async () => ({ state: 'candidate', candidateKey: '12:34:100:56' });
  assert.deepEqual(await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => readEpisode(12345), probeImpl }),
  { state: 'shoko_files_identified', files: [{ name: 'Movie.mkv',
    fileId: 77, releaseEvidence: 'registered' }] });
  assert.deepEqual(await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => readEpisode(null), probeImpl }),
  { state: 'held', reason: 'shoko_provenance_unverified' });
});

test('the default probe checks real inode, size and mtime without reading bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-observer-'));
  try {
    const pathname = path.join(root, 'Movie.mkv');
    await writeFile(pathname, Buffer.alloc(100));
    const physical = await stat(pathname, { bigint: true });
    const actualMove = { ...move, manifest: { files: [{
      ...move.manifest.files[0], dev: String(physical.dev),
      ino: String(physical.ino), mtimeNs: String(physical.mtimeNs),
    }] } };
    const actualMount = { appRoot: '/pure', localRoot: root };
    const readEpisode = async () => ({ state: 'ok', complete: true, files: [
      { ...file, sourcePaths: ['/pure/Movie.mkv'] },
    ] });
    assert.equal((await observePureMoveImport({ move: actualMove, target,
      shokoMount: actualMount, readEpisode })).state, 'shoko_files_identified');
    const changedMove = { ...actualMove, manifest: { files: [{
      ...actualMove.manifest.files[0], mtimeNs: '1',
    }] } };
    assert.deepEqual(await observePureMoveImport({ move: changedMove, target,
      shokoMount: actualMount, readEpisode }),
    { state: 'awaiting_shoko', episodeId: 901 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an older matching episode cannot prove the new handoff', async () => {
  const result = await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => ({ state: 'ok', complete: true, files: [file] }),
    probeImpl: async () => ({ state: 'candidate', candidateKey: '12:35:100:56' }),
  });
  assert.deepEqual(result, { state: 'awaiting_shoko', episodeId: 901 });
});

test('a wrong Shoko anime or incomplete episode link cannot prove the handoff', async () => {
  const result = await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => ({ state: 'ok', complete: true, files: [
      { ...file, anidbId: 501 },
      { ...file, fileId: 78, coverage: [{ episodeId: 901, start: 0, end: 50 }] },
    ] }),
    probeImpl: async () => ({ state: 'candidate', candidateKey: '12:34:100:56' }),
  });
  assert.deepEqual(result, { state: 'awaiting_shoko', episodeId: 901 });
});

test('ambiguous Shoko file IDs stay held', async () => {
  const result = await observePureMoveImport({ move, target, shokoMount,
    readEpisode: async () => ({ state: 'ok', complete: true, files: [
      file, { ...file, fileId: 78 },
    ] }),
    probeImpl: async () => ({ state: 'candidate', candidateKey: '12:34:100:56' }),
  });
  assert.deepEqual(result, { state: 'held', reason: 'ambiguous_shoko_file' });
});

test('a multi-episode video must be listed under every claimed Shoko episode', async () => {
  const batch = { ...move, manifest: { files: [
    { ...move.manifest.files[0], episodeIds: [901, 902] },
  ] } };
  const result = await observePureMoveImport({ move: batch,
    target: { anidbId: 500, episodeIds: [901, 902] }, shokoMount,
    readEpisode: async ({ episodeId }) => ({ state: 'ok', complete: true,
      files: episodeId === 901 ? [{ ...file, episodeIds: [901, 902],
        coverage: [{ episodeId: 901, start: 0, end: 100 },
          { episodeId: 902, start: 0, end: 100 }] }] : [] }),
    probeImpl: async () => ({ state: 'candidate', candidateKey: '12:34:100:56' }),
  });
  assert.deepEqual(result, { state: 'awaiting_shoko', episodeId: 902 });
});
