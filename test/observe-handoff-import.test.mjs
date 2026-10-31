import assert from 'node:assert/strict';
import test from 'node:test';
import { observeHandoffImport } from '../src/acquisition/observe-handoff-import.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

const video = (fileId, episodeIds) => ({ name: `${fileId}.mkv`, size: 123,
  anidbFileId: fileId, ed2k: 'A'.repeat(32), episodeIds });
const manifest = { version: 1,
  anidbId: 42, torrentHash: 'b'.repeat(40),
  videos: [video(800, [1001]), video(801, [1002])], subtitles: [] };
const withEvidence = (manifest) => ({ status: 'published_observed', manifest,
  evidenceDigest: evaluateHandoffEvidence({ ...manifest, files: manifest.videos }).digest });
const row = withEvidence(manifest);
const observed = (fileId, episodeIds) => ({ fileId: fileId + 1000,
  anidbFileId: fileId, ed2k: 'A'.repeat(32), size: 123,
  anidbId: 42, episodeIds,
  coverage: episodeIds.map((episodeId) => ({ episodeId, start: 0, end: 100 })),
  sourcePaths: [`/pure/Anime/${fileId}.mkv`] });

test('each exact claimed video must be identified in Shoko before import is observed', async () => {
  const calls = [];
  const result = await observeHandoffImport({ handoff: row,
    readEpisode: async ({ anidbId, episodeId }) => {
      calls.push([anidbId, episodeId]);
      return { state: 'ok', complete: true,
        files: [observed(episodeId === 1001 ? 800 : 801, [episodeId])] };
    } });
  assert.deepEqual(calls, [[42, 1001], [42, 1002]]);
  assert.deepEqual(result, { state: 'shoko_import_observed', fileIds: [1800, 1801] });
});

test('missing, wrong, or partial Shoko identities cannot complete the handoff', async () => {
  for (const changed of [
    { state: 'not_imported' },
    { state: 'ok', complete: true, files: [] },
    { state: 'ok', complete: true },
    { state: 'ok', complete: true, files: [observed(900, [1002])] },
    { state: 'ok', complete: true, files: [{ ...observed(801, [1002]),
      coverage: [{ episodeId: 1002, start: 0, end: 50 }] }] },
    { state: 'unavailable' },
  ]) {
    const result = await observeHandoffImport({ handoff: row,
      readEpisode: async ({ episodeId }) => episodeId === 1001
        ? { state: 'ok', complete: true, files: [observed(800, [1001])] }
        : changed });
    assert.notEqual(result.state, 'shoko_import_observed');
  }
});

test('one multi-episode file needs a stable Shoko file identity across episodes', async () => {
  const multi = withEvidence({ ...row.manifest,
    videos: [video(800, [1001, 1002])] });
  const result = await observeHandoffImport({ handoff: multi,
    readEpisode: async ({ episodeId }) => ({ state: 'ok', complete: true,
      files: [{ ...observed(800, [1001, 1002]), fileId: episodeId + 1000 }] }) });
  assert.notEqual(result.state, 'shoko_import_observed');
  const exact = await observeHandoffImport({ handoff: multi,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [observed(800, [1001, 1002])] }) });
  assert.deepEqual(exact, { state: 'shoko_import_observed', fileIds: [1800] });
});

test('a merely published-unknown handoff cannot claim import completion', async () => {
  let calls = 0;
  assert.deepEqual(await observeHandoffImport({
    handoff: { ...row, status: 'publish_unknown' },
    readEpisode: async () => { calls++; return { state: 'ok', complete: true, files: [] }; },
  }), { state: 'held', reason: 'publish_not_observed' });
  assert.equal(calls, 0);
});
