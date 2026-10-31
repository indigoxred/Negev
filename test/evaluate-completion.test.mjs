import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompletion } from '../src/acquisition/evaluate-completion.mjs';

const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const expected = { hash, category: 'negev', savePath: '/negev-stage' };
const torrent = {
  hash, category: 'negev', save_path: '/negev-stage',
  state: 'pausedUP', progress: 1, amount_left: 0,
};
const video = { index: 0, name: 'Show/episode.mkv', size: 12345, progress: 1, priority: 1, is_seed: true };

test('accepts a complete selected video and ignores an excluded extra', () => {
  const files = [video, { index: 1, name: 'Show/sample.exe', size: 10, progress: 0, priority: 0, is_seed: false }];
  assert.deepEqual(evaluateCompletion({ torrent, files, expected }), {
    state: 'complete', files: [{ index: 0, name: 'Show/episode.mkv', size: 12345 }],
  });
});

test('holds incomplete torrent or selected file', () => {
  assert.deepEqual(evaluateCompletion({ torrent: { ...torrent, state: 'stalledDL', progress: 0.9, amount_left: 100 }, files: [video], expected }), {
    state: 'held', reason: 'incomplete',
  });
  assert.deepEqual(evaluateCompletion({ torrent, files: [{ ...video, progress: 0.99, is_seed: false }], expected }), {
    state: 'held', reason: 'incomplete',
  });
});

test('holds another category, save path or torrent hash', () => {
  assert.equal(evaluateCompletion({ torrent: { ...torrent, category: 'manual' }, files: [video], expected }).reason, 'wrong_torrent_owner');
  assert.equal(evaluateCompletion({ torrent: { ...torrent, save_path: '/Shoko' }, files: [video], expected }).reason, 'wrong_save_path');
  assert.equal(evaluateCompletion({ torrent: { ...torrent, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, files: [video], expected }).reason, 'wrong_torrent_owner');
});

test('holds any selected executable or unexpected file', () => {
  for (const name of ['Show/setup.exe', 'Show/run.sh', '../escape.mkv', '/absolute.mkv', 'Show/episode.mkv.exe']) {
    assert.deepEqual(evaluateCompletion({ torrent, files: [video, { ...video, index: 1, name }], expected }), {
      state: 'held', reason: 'unsafe_selected_file',
    });
  }
});

test('holds while qBittorrent is checking or has no selected video', () => {
  assert.equal(evaluateCompletion({ torrent: { ...torrent, state: 'checkingUP' }, files: [video], expected }).reason, 'incomplete');
  assert.equal(evaluateCompletion({ torrent, files: [{ ...video, priority: 0 }], expected }).reason, 'no_selected_video');
});

test('does not release a pack while any selected video is unfinished', () => {
  const files = [video, { ...video, index: 1, name: 'Show/episode-2.mkv', progress: 0.8, is_seed: false }];
  assert.deepEqual(evaluateCompletion({ torrent, files, expected }), { state: 'held', reason: 'incomplete' });
});
