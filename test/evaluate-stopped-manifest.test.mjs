import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateStoppedManifest } from '../src/acquisition/evaluate-stopped-manifest.mjs';

const hash = 'a'.repeat(40);
const expected = { hash, category: 'negev', savePath: `/Downloads/negev/${hash}` };
const torrent = {
  hash, category: 'negev', save_path: expected.savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0,
  auto_tmm: false, force_start: false,
};
const video = { index: 0, name: 'Show/01.mkv', size: 1_000, priority: 1, progress: 0 };

test('accepts the exact configured qBittorrent root and rejects the default root', () => {
  const custom = { ...expected, savePath: `/data/torrents/negev/${hash}` };
  const observed = { ...torrent, save_path: custom.savePath };
  assert.equal(evaluateStoppedManifest({ torrent: observed, files: [video],
    expected: custom, saveRoot: '/data/torrents/negev' }).state, 'manifest_safe');
  assert.throws(() => evaluateStoppedManifest({ torrent: observed,
    files: [video], expected: custom }), TypeError);
});

test('accepts only a stopped, untouched torrent with selected videos and subtitles', () => {
  const files = [video,
    { index: 1, name: 'Show/01.ass', size: 100, priority: 1, progress: 0 },
    { index: 2, name: 'Show/readme.txt', size: 20, priority: 0, progress: 0 }];
  assert.deepEqual(evaluateStoppedManifest({ torrent, files, expected }), {
    state: 'manifest_safe',
    videos: [{ index: 0, name: 'Show/01.mkv', size: 1_000 }],
    subtitles: [{ index: 1, name: 'Show/01.ass', size: 100 }],
  });
});

test('holds a running, changed, existing, or wrong-owner torrent', () => {
  for (const change of [
    { state: 'downloading' }, { state: 'checkingDL' },
    { progress: 0.01 }, { downloaded: 100 },
    { auto_tmm: true }, { force_start: true },
  ]) assert.deepEqual(evaluateStoppedManifest({ torrent: { ...torrent, ...change }, files: [video], expected }),
    { state: 'held', reason: 'not_pristine_stopped' });
  assert.equal(evaluateStoppedManifest({ torrent: { ...torrent, hash: 'b'.repeat(40) }, files: [video], expected }).reason,
    'wrong_torrent_owner');
  assert.equal(evaluateStoppedManifest({ torrent: { ...torrent, category: 'Sonarr' }, files: [video], expected }).reason,
    'wrong_torrent_owner');
  assert.equal(evaluateStoppedManifest({ torrent: { ...torrent, save_path: '/Shoko' }, files: [video], expected }).reason,
    'wrong_save_path');
});

test('holds unsafe names even when excluded and any selected unexpected type', () => {
  for (const name of ['../escape.mkv', '/root/01.mkv', 'Show\\01.mkv', 'Show/run.sh',
    'Show/setup.exe', 'Show/episode.mkv.exe', 'Show/one\0.mkv',
    'Show/payload.py', 'Show/archive.zip']) {
    assert.equal(evaluateStoppedManifest({ torrent,
      files: [video, { index: 1, name, size: 2, priority: 0, progress: 0 }], expected }).reason,
    'unsafe_file');
  }
  assert.equal(evaluateStoppedManifest({ torrent,
    files: [video, { index: 1, name: 'Show/readme.txt', size: 2, priority: 1, progress: 0 }], expected }).reason,
    'unexpected_selected_file');
});

test('can identify passive files that need exclusion while torrent stays stopped', () => {
  const files = [video, { index: 1, name: 'Show/readme.nfo', size: 20,
    priority: 1, progress: 0 }];
  assert.deepEqual(evaluateStoppedManifest({ torrent, files, expected,
    allowSelectedPassive: true }), {
    state: 'manifest_needs_exclusions', passive: [{ index: 1,
      name: 'Show/readme.nfo', size: 20 }],
  });
  assert.deepEqual(evaluateStoppedManifest({ torrent, files, expected }),
    { state: 'held', reason: 'unexpected_selected_file' });
  assert.equal(evaluateStoppedManifest({ torrent, files: [video, {
    ...files[1], name: 'Show/run.exe' }], expected,
  allowSelectedPassive: true }).reason, 'unsafe_file');
});

test('holds duplicate, incomplete, empty, or excessive manifests', () => {
  for (const files of [[], [video, { ...video }], [video, { ...video, index: 1 }],
    [{ ...video, size: 0 }], [{ ...video, progress: 0.1 }],
    [{ ...video, priority: 0 }], Array.from({ length: 501 }, (_, index) => ({ ...video, index, name: `${index}.mkv` }))]) {
    assert.equal(evaluateStoppedManifest({ torrent, files, expected }).state, 'held');
  }
  assert.throws(() => evaluateStoppedManifest({ torrent, files: [video], expected: { ...expected, hash: 'bad' } }), TypeError);
});
