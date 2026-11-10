import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

const first = { name: 'Show/01.mkv', size: 3, ed2k: 'A'.repeat(32),
  anidbFileId: 51, episodeIds: [1001] };
const second = { name: 'Show/02.mkv', size: 4, ed2k: 'B'.repeat(32),
  anidbFileId: 52, episodeIds: [1002] };
const sidecar = { index: 2, name: 'Show/01.en.srt', size: 5, sha256: 'C'.repeat(64) };
const input = { anidbId: 42, torrentHash: 'd'.repeat(40),
  files: [second, first], subtitles: [sidecar] };

test('canonical handoff evidence survives reordering and retains exact identities', () => {
  const one = evaluateHandoffEvidence(input);
  const two = evaluateHandoffEvidence({ ...input, files: [first, second] });
  assert.equal(one.state, 'valid');
  assert.equal(one.digest, two.digest);
  assert.match(one.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(one.manifest.videos.map((file) => file.anidbFileId), [51, 52]);
  assert.deepEqual(one.manifest.subtitles, [sidecar]);
});

test('unsafe, duplicate, and over-budget handoff evidence holds', () => {
  for (const change of [
    { files: [{ ...first, name: '../escape.mkv' }] },
    { files: [first, { ...second, name: first.name.toUpperCase() }] },
    { files: [first, { ...second, episodeIds: [1001] }] },
    { subtitles: [{ ...sidecar, name: 'Show/run.sh' }] },
    { subtitles: [{ ...sidecar, size: 16 * 1024 ** 2 + 1 }] },
    { torrentHash: 'invalid' },
  ]) {
    assert.deepEqual(evaluateHandoffEvidence({ ...input, ...change }),
      { state: 'held', reason: 'invalid_handoff_evidence' });
  }
});

test('legacy AniDB manifest and digest stay byte-for-byte stable', () => {
  const result = evaluateHandoffEvidence({ anidbId: 42,
    torrentHash: 'd'.repeat(40), files: [first], subtitles: [] });
  assert.equal(JSON.stringify(result.manifest),
    '{"version":1,"torrentHash":"dddddddddddddddddddddddddddddddddddddddd","anidbId":42,"videos":[{"name":"Show/01.mkv","size":3,"ed2k":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","anidbFileId":51,"episodeIds":[1001]}],"subtitles":[]}');
  assert.equal(result.digest,
    'b1b95c834f515cc9622825361b736a22441622e42068d251ab92631f67a8d2d7');
});

test('offline identity has a distinct version-two manifest and digest', () => {
  const offline = { name: 'Show/01.mkv', size: 3,
    ed2k: 'A'.repeat(32), episodeIds: [1001],
    identitySource: 'shoko_offline', releaseId: 'offline://42-1001' };
  const result = evaluateHandoffEvidence({ ...input, files: [offline],
    subtitles: [] });
  assert.equal(result.state, 'valid');
  assert.deepEqual(result.manifest.videos, [offline]);
  assert.equal(result.manifest.version, 2);
  assert.notEqual(result.digest,
    evaluateHandoffEvidence({ ...input, files: [first], subtitles: [] }).digest);
});

test('mixed registered and offline files retain disjoint identities', () => {
  const offline = { name: 'Show/02.mkv', size: 4,
    ed2k: 'B'.repeat(32), episodeIds: [1002],
    identitySource: 'shoko_offline', releaseId: 'offline://42-1002' };
  const result = evaluateHandoffEvidence({ ...input,
    files: [{ ...first, identitySource: 'anidb' }, offline], subtitles: [] });
  assert.equal(result.state, 'valid');
  assert.equal(result.manifest.version, 2);
  assert.deepEqual(result.manifest.videos[0],
    { name: first.name, size: first.size, ed2k: first.ed2k,
      identitySource: 'anidb', anidbFileId: 51, episodeIds: [1001] });
  assert.deepEqual(result.manifest.videos[1], offline);
});

test('offline evidence rejects forged IDs, ambiguous files and mixed legacy forms', () => {
  const offline = { name: 'Show/01.mkv', size: 3,
    ed2k: 'A'.repeat(32), episodeIds: [1001],
    identitySource: 'shoko_offline', releaseId: 'offline://42-1001' };
  for (const files of [
    [{ ...offline, releaseId: 'offline://42-1002' }],
    [{ ...offline, anidbFileId: 51 }],
    [{ ...offline, episodeIds: [1001, 1002] }],
    [offline, { ...offline, name: 'Show/other.mkv', ed2k: 'B'.repeat(32) }],
    [offline, second],
  ]) {
    assert.deepEqual(evaluateHandoffEvidence({ ...input, files,
      subtitles: [] }), { state: 'held', reason: 'invalid_handoff_evidence' });
  }
});
