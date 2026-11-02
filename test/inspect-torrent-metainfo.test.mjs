import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectTorrentMetainfo } from '../src/acquisition/inspect-torrent-metainfo.mjs';

function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  const entries = Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, item]) => [encode(key), encode(item)]), Buffer.from('e')]);
}

const v1Info = { length: 1000, name: 'Example.mkv', 'piece length': 16384, pieces: Buffer.alloc(20, 7) };
const torrent = (info, extras = {}) => encode({ announce: 'https://tracker.invalid/announce', ...extras, info });
const inspect = (bytes) => inspectTorrentMetainfo({ bytes: new Uint8Array(bytes) });

test('extracts a canonical v1 info hash and one safe file', () => {
  const result = inspect(torrent(v1Info));
  assert.deepEqual(result, {
    state: 'metainfo_checked', version: 'v1',
    hash: createHash('sha1').update(encode(v1Info)).digest('hex'),
    totalBytes: 1000, files: [{ name: 'Example.mkv', size: 1000 }],
  });
  assert.equal(inspect(torrent(v1Info, { comment: 'changed tracker metadata' })).hash, result.hash);
});

test('omits genuine pad entries from the qBittorrent-visible file list', () => {
  const info = { name: 'Show', 'piece length': 16384, pieces: Buffer.alloc(20, 7),
    files: [{ length: 1000, path: ['01.mkv'] },
      { attr: 'p', length: 100, path: ['.pad', '100'] }] };
  assert.deepEqual(inspect(torrent(info)).files, [{ name: '01.mkv', size: 1000 }]);
  assert.equal(inspect(torrent({ ...info, files: [
    info.files[0], { attr: 'p', length: 100, path: ['.pad', '101'] },
  ] })).state, 'held');
});

test('holds torrents that mark a selected media path with file attributes', () => {
  const single = { ...v1Info, attr: 'x' };
  const multi = { name: 'Show', 'piece length': 16384,
    pieces: Buffer.alloc(20, 7), files: [{ attr: 'x', length: 1000,
      path: ['01.mkv'] }] };
  const v2 = { 'file tree': { '01.mkv': { '': { attr: 'x',
    length: 1000, 'pieces root': Buffer.alloc(32, 2) } } },
    'meta version': 2, name: 'Show', 'piece length': 16384 };
  const topLevelV2Attribute = { ...v2, attr: 'x',
    'file tree': { '01.mkv': { '': { length: 1000,
      'pieces root': Buffer.alloc(32, 2) } } } };
  for (const bytes of [torrent(single), torrent(multi),
    torrent(v2, { 'piece layers': {} }),
    torrent(topLevelV2Attribute, { 'piece layers': {} })]) {
    assert.deepEqual(inspect(bytes), { state: 'held', reason: 'invalid_metainfo' });
  }
});

test('derives qBittorrent truncated SHA-256 ID for a v2 torrent', () => {
  const info = { 'file tree': { 'Example.mkv': { '': { length: 1000, 'pieces root': Buffer.alloc(32, 2) } } },
    'meta version': 2, name: 'Example', 'piece length': 16384 };
  const result = inspect(torrent(info, { 'piece layers': {} }));
  assert.deepEqual(result, {
    state: 'metainfo_checked', version: 'v2',
    hash: createHash('sha256').update(encode(info)).digest('hex').slice(0, 40),
    totalBytes: 1000, files: [{ name: 'Example.mkv', size: 1000 }],
  });
});

test('hybrid v1 and v2 descriptions must name the same files and sizes', () => {
  const info = { ...v1Info, name: 'Show', files: [{ length: 1000, path: ['01.mkv'] }],
    'file tree': { '01.mkv': { '': { length: 1000, 'pieces root': Buffer.alloc(32, 2) } } },
    'meta version': 2 };
  delete info.length;
  assert.equal(inspect(torrent(info, { 'piece layers': {} })).version, 'hybrid');
  assert.deepEqual(inspect(torrent({ ...info, 'file tree': { '02.mkv': info['file tree']['01.mkv'] } },
    { 'piece layers': {} })), { state: 'held', reason: 'conflicting_file_views' });
  const disguised = { ...info, files: [
    { attr: 'p', length: 100, path: ['01.mkv'] },
    { length: 1000, path: ['02.mkv'] },
  ], 'file tree': { '02.mkv': info['file tree']['01.mkv'] } };
  assert.equal(inspect(torrent(disguised, { 'piece layers': {} })).state, 'held');
});

test('rejects noncanonical encodings and malformed structure before hashing', () => {
  const highBitInteger = torrent(v1Info);
  highBitInteger[highBitInteger.indexOf(Buffer.from('i1000e')) + 1] = 0xb1;
  for (const bytes of [
    highBitInteger,
    Buffer.from('d4:infod4:name1:x4:name1:yee'),
    Buffer.from('d4:infod4:name1:xe4:infoi1ee'),
    Buffer.from('d4:infod6:lengthi01eee'),
    Buffer.from('d4:infod6:lengthi-0eee'),
    Buffer.from('d4:infod6:length999999999999999999999999:xee'),
    Buffer.from('d4:infoleejunk'),
  ]) assert.equal(inspect(bytes).state, 'held');
});

test('rejects traversal, unsafe names, mismatched pieces and excessive metainfo', () => {
  const badFiles = { ...v1Info, name: 'Show', files: [{ length: 1000, path: ['..', 'escape.mkv'] }] };
  delete badFiles.length;
  assert.deepEqual(inspect(torrent(badFiles)), { state: 'held', reason: 'unsafe_file_path' });
  assert.equal(inspect(torrent({ ...v1Info, pieces: Buffer.alloc(40) })).state, 'held');
  assert.equal(inspect(torrent({ ...v1Info, name: 'setup\\evil.mkv' })).state, 'held');
  assert.equal(inspect(new Uint8Array(2_000_001)).state, 'held');
});
