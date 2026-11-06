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

test('provisional handoff gets a distinct durable manifest without a fabricated AniDB file ID', () => {
  const videos = [
    { name: first.name, size: first.size, ed2k: first.ed2k,
      episodeIds: first.episodeIds },
    { name: second.name, size: second.size, ed2k: second.ed2k,
      episodeIds: second.episodeIds },
  ];
  const candidate = evaluateHandoffEvidence({ ...input,
    identity: 'provisional', files: [...videos].reverse() });
  assert.equal(candidate.state, 'valid');
  assert.equal(candidate.manifest.version, 2);
  assert.equal(candidate.manifest.identity, 'provisional');
  assert.equal(candidate.manifest.videos[0].anidbFileId, undefined);
  const restored = evaluateHandoffEvidence({ ...candidate.manifest,
    files: candidate.manifest.videos });
  assert.deepEqual(restored, candidate);
  assert.notEqual(candidate.digest, evaluateHandoffEvidence(input).digest);
});

test('provisional handoff refuses exact IDs and unsafe episode evidence', () => {
  const provisional = { ...input, identity: 'provisional',
    files: [{ name: first.name, size: first.size, ed2k: first.ed2k,
      episodeIds: [1001] }] };
  for (const change of [
    { files: [first] },
    { files: [{ ...provisional.files[0], episodeIds: [1001, 1001] }] },
    { files: [{ ...provisional.files[0], ed2k: 'bad' }] },
    { files: [{ ...provisional.files[0], name: '../01.mkv' }] },
    { identity: 'unknown' },
  ]) {
    assert.deepEqual(evaluateHandoffEvidence({ ...provisional, ...change }),
      { state: 'held', reason: 'invalid_handoff_evidence' });
  }
});
