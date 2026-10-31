import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStoppedTorrentAddForm } from '../src/acquisition/qbittorrent-add-form.mjs';

const input = {
  torrentBytes: Uint8Array.from([100, 52, 58, 105, 110, 102, 111, 101]),
  savePath: '/negev-staging',
  category: 'negev',
};

test('constructs one stopped qBittorrent v5 upload at an explicit staging path', async () => {
  const form = buildStoppedTorrentAddForm(input);
  assert.equal(form.get('savepath'), '/negev-staging');
  assert.equal(form.get('category'), 'negev');
  assert.equal(form.get('paused'), 'true');
  assert.equal(form.get('autoTMM'), 'false');
  assert.equal(form.get('skip_checking'), 'false');
  assert.deepEqual([...form.keys()].sort(), [
    'autoTMM', 'category', 'paused', 'savepath', 'skip_checking', 'torrents',
  ]);
  const file = form.get('torrents');
  assert.equal(file.name, 'candidate.torrent');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), input.torrentBytes);
});

test('refuses ambiguous path, unsafe category, and unbounded or absent torrent data', () => {
  for (const savePath of ['/', '/negev-staging/', '/negev-staging/../Import',
    '/pure/Import', '/Shoko', 'relative', '/negev-staging\nother']) {
    assert.throws(() => buildStoppedTorrentAddForm({ ...input, savePath }), TypeError);
  }
  for (const category of ['', 'negev,Sonarr', 'with space']) {
    assert.throws(() => buildStoppedTorrentAddForm({ ...input, category }), TypeError);
  }
  assert.throws(() => buildStoppedTorrentAddForm({ ...input, torrentBytes: new Uint8Array() }), TypeError);
  assert.throws(() => buildStoppedTorrentAddForm({ ...input, torrentBytes: new Uint8Array(2_000_001) }), TypeError);
  assert.throws(() => buildStoppedTorrentAddForm({ ...input, torrentBytes: 'magnet:?xt=abc' }), TypeError);
});
