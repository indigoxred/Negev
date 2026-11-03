import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stagingSavePath, matchesStagingSavePath } from
  '../src/acquisition/staging-save-path.mjs';

const hash = 'a'.repeat(40);

test('one hash has a distinct directory under the configured qBittorrent root', () => {
  assert.equal(stagingSavePath(hash, { saveRoot: '/data/torrents/negev' }),
    `/data/torrents/negev/${hash}`);
  assert.equal(stagingSavePath(hash, { saveRoot: '/Downloads/negev' }),
    `/Downloads/negev/${hash}`);
  assert.equal(matchesStagingSavePath({ hash,
    savePath: `/data/torrents/negev/${hash}` },
  { saveRoot: '/data/torrents/negev' }), true);
  assert.equal(matchesStagingSavePath({ hash,
    savePath: `/Downloads/negev/${hash}` },
  { saveRoot: '/data/torrents/negev' }), false);
});

test('configured staging roots reject ambiguous and unsafe paths', () => {
  for (const saveRoot of ['/', '/data/../private', '/data//negev',
    '/data/negev/', 'relative/negev', '/data/./negev',
    '/data/negev\\escape', '/data/negev\0escape']) {
    assert.throws(() => stagingSavePath(hash, { saveRoot }), TypeError);
  }
  assert.throws(() => stagingSavePath('a'.repeat(39),
    { saveRoot: '/data/negev' }), TypeError);
});
