import assert from 'node:assert/strict';
import test from 'node:test';
import { observeHandoffImport, observeHandoffPlacement, reconcileHandoffContent } from '../src/acquisition/observe-handoff-import.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { readShokoEpisodeFiles } from '../src/availability/shoko-episode-files.mjs';

const video = (fileId, episodeIds) => ({ name: `${fileId}.mkv`, size: 123,
  anidbFileId: fileId, ed2k: 'A'.repeat(32), episodeIds });
const manifest = { version: 1,
  anidbId: 42, torrentHash: 'b'.repeat(40),
  videos: [video(800, [1001]), video(801, [1002])], subtitles: [] };
const withEvidence = (manifest) => ({ status: 'published_observed', manifest,
  evidenceDigest: evaluateHandoffEvidence({ ...manifest, files: manifest.videos }).digest });
const row = withEvidence(manifest);
const provisionalInput = { version: 2, identity: 'provisional',
  anidbId: 42, torrentHash: 'b'.repeat(40),
  videos: [{ name: '05.mkv', size: 123, ed2k: 'A'.repeat(32),
    episodeIds: [1005] }], subtitles: [] };
const provisionalEvidence = evaluateHandoffEvidence({ ...provisionalInput,
  files: provisionalInput.videos });
const provisionalRow = { status: 'published_observed',
  manifest: provisionalEvidence.manifest,
  evidenceDigest: provisionalEvidence.digest };
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
  assert.deepEqual(result, { state: 'shoko_files_identified', fileIds: [1800, 1801] });
});

test('provisional handoff observes exact imported bytes without a registered file ID', async () => {
  let readEpisodeCalled = false;
  assert.deepEqual(await observeHandoffImport({ handoff: provisionalRow,
    readEpisode: async () => { readEpisodeCalled = true; },
    readImportedFile: async () => ({ state: 'imported_unrecognized',
      fileId: 19711, ed2k: 'A'.repeat(32), size: 123 }) }),
  { state: 'awaiting_shoko_link', fileId: 19711 });
  assert.equal(readEpisodeCalled, false);
});

test('library placement requires every exact Shoko file to have an accessible final-library path', async () => {
  const readEpisode = async ({ episodeId }) => ({ state: 'ok', complete: true,
    files: [{ ...observed(episodeId === 1001 ? 800 : 801, [episodeId]),
      sourcePaths: episodeId === 1001
        ? ['/pure/Anime/800.mkv'] : ['/pure/Import/801.mkv'] }] });
  assert.deepEqual(await observeHandoffPlacement({ handoff: row, readEpisode,
    libraryRoot: '/pure/Anime' }),
  { state: 'awaiting_shoko_placement', episodeId: 1002 });
  assert.deepEqual(await observeHandoffImport({ handoff: row, readEpisode }),
    { state: 'shoko_files_identified', fileIds: [1800, 1801] });
  assert.deepEqual(await observeHandoffPlacement({ handoff: row,
    libraryRoot: '/pure/Anime', readEpisode: async ({ episodeId }) => ({
      state: 'ok', complete: true,
      files: [observed(episodeId === 1001 ? 800 : 801, [episodeId])] }) }),
  { state: 'shoko_library_location_reported', fileIds: [1800, 1801] });
});

test('placement rejects prefix siblings, malformed library roots and unpublished handoffs', async () => {
  const readEpisode = async ({ episodeId }) => ({ state: 'ok', complete: true,
    files: [{ ...observed(episodeId === 1001 ? 800 : 801, [episodeId]),
      sourcePaths: [`/pure/Anime-old/${episodeId}.mkv`] }] });
  assert.deepEqual(await observeHandoffPlacement({ handoff: row, readEpisode,
    libraryRoot: '/pure/Anime' }),
  { state: 'awaiting_shoko_placement', episodeId: 1001 });
  await assert.rejects(() => observeHandoffPlacement({ handoff: row,
    readEpisode, libraryRoot: '/pure/Anime/../Import' }), TypeError);
  assert.deepEqual(await observeHandoffPlacement({
    handoff: { ...row, status: 'publish_unknown' }, readEpisode,
    libraryRoot: '/pure/Anime' }),
  { state: 'held', reason: 'publish_not_observed' });
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
    assert.notEqual(result.state, 'shoko_files_identified');
  }
});

test('one multi-episode file needs a stable Shoko file identity across episodes', async () => {
  const multi = withEvidence({ ...row.manifest,
    videos: [video(800, [1001, 1002])] });
  const result = await observeHandoffImport({ handoff: multi,
    readEpisode: async ({ episodeId }) => ({ state: 'ok', complete: true,
      files: [{ ...observed(800, [1001, 1002]), fileId: episodeId + 1000 }] }) });
  assert.notEqual(result.state, 'shoko_files_identified');
  const exact = await observeHandoffImport({ handoff: multi,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [observed(800, [1001, 1002])] }) });
  assert.deepEqual(exact, { state: 'shoko_files_identified', fileIds: [1800] });
});

test('a merely published-unknown handoff cannot claim import completion', async () => {
  let calls = 0;
  assert.deepEqual(await observeHandoffImport({
    handoff: { ...row, status: 'publish_unknown' },
    readEpisode: async () => { calls++; return { state: 'ok', complete: true, files: [] }; },
  }), { state: 'held', reason: 'publish_not_observed' });
  assert.equal(calls, 0);
});

test('durable publish intent permits content observation without inventing publication proof', async () => {
  const unknown = { ...row, status: 'publish_unknown',
    publishName: `negev-7-${row.evidenceDigest.slice(0, 16)}` };
  let recorded = 0;
  const ledger = { getHandoff: (attemptId) => attemptId === 7 ? unknown : null,
    recordContentPresent: ({ fileIds }) => { recorded++;
      return { state: 'content_present', publicationProven: false, fileIds }; } };
  const result = await reconcileHandoffContent({ attemptId: 7, ledger, nowMs: 500,
    readEpisode: async ({ episodeId }) => ({ state: 'ok', complete: true,
      files: [observed(episodeId === 1001 ? 800 : 801, [episodeId])] }) });
  assert.deepEqual(result, { state: 'content_present',
    publicationProven: false, fileIds: [1800, 1801] });
  assert.equal(recorded, 1);
  assert.equal(ledger.getHandoff(7).status, 'publish_unknown');
  let calls = 0;
  assert.deepEqual(await reconcileHandoffContent({ attemptId: 8, ledger, nowMs: 501,
    readEpisode: async () => { calls++; return { state: 'ok', complete: true, files: [] }; } }),
  { state: 'held', reason: 'publish_intent_missing' });
  assert.equal(calls, 0);
});

test('published handoff is matched through the bounded Shoko episode adapter', async () => {
  const single = withEvidence({ ...manifest, videos: [video(800, [1001])] });
  const payload = { IDs: { AniDB: 1001 }, Files: [{ ID: 1800, Size: 123,
    IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
    Release: { ID: `anidb://${'A'.repeat(32)}+123`, ProviderName: 'AniDB',
      ReleaseURI: 'https://anidb.net/file/800', FileSize: 123,
      IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
      CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
        PercentageStart: null, PercentageEnd: null }] },
    Locations: [{ FileID: 1800, IsAccessible: true,
      AbsolutePath: '/pure/Anime/Example/01.mkv' }] }] };
  const result = await observeHandoffImport({ handoff: single,
    readEpisode: ({ anidbId, episodeId }) => readShokoEpisodeFiles({
      baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic',
      anidbId, episodeId, fetchImpl: async () => Response.json(payload),
    }) });
  assert.deepEqual(result, { state: 'shoko_files_identified', fileIds: [1800] });
});
