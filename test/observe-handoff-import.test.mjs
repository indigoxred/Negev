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
const observed = (fileId, episodeIds) => ({ fileId: fileId + 1000,
  anidbFileId: fileId, ed2k: 'A'.repeat(32), size: 123,
  anidbId: 42, episodeIds,
  coverage: episodeIds.map((episodeId) => ({ episodeId, start: 0, end: 100 })),
  sourcePaths: [`/pure/Anime/${fileId}.mkv`] });

const offlineManifest = { version: 2, anidbId: 42,
  torrentHash: 'b'.repeat(40), videos: [{ name: '01.mkv', size: 123,
    identitySource: 'shoko_offline', releaseId: 'offline://42-1001',
    ed2k: 'A'.repeat(32), episodeIds: [1001] }], subtitles: [] };
const offlineRow = withEvidence(offlineManifest);

test('offline handoff needs the same imported Shoko bytes and full episode link', async () => {
  const exact = { ...observed(800, [1001]), anidbFileId: null,
    releaseEvidence: 'shoko_offline_link', releaseId: 'offline://42-1001' };
  assert.deepEqual(await observeHandoffPlacement({ handoff: offlineRow,
    libraryRoot: '/pure/Anime', readEpisode: async () => ({ state: 'ok',
      complete: true, files: [exact] }) }),
  { state: 'shoko_library_location_reported', fileIds: [1800] });
  for (const changed of [
    { ...exact, releaseEvidence: 'shoko_user_link' },
    { ...exact, releaseId: 'offline://42-1002' },
    { ...exact, ed2k: 'B'.repeat(32) },
    { ...exact, coverage: [{ episodeId: 1001, start: 0, end: 50 }] },
  ]) {
    assert.notEqual((await observeHandoffImport({ handoff: offlineRow,
      readEpisode: async () => ({ state: 'ok', complete: true,
        files: [changed] }) })).state, 'shoko_files_identified');
  }
});

test('offline handoff accepts the same exact bytes after Shoko registers them with AniDB', async () => {
  const registered = observed(800, [1001]);
  assert.deepEqual(await observeHandoffImport({ handoff: offlineRow,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [registered] }) }),
  { state: 'shoko_files_identified', fileIds: [1800] });
  assert.deepEqual(await observeHandoffPlacement({ handoff: offlineRow,
    libraryRoot: '/pure/Anime', readEpisode: async () => ({ state: 'ok',
      complete: true, files: [registered] }) }),
  { state: 'shoko_library_location_reported', fileIds: [1800] });
});

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

test('a duplicated Shoko episode ID cannot stand in for another covered episode', async () => {
  const multi = withEvidence({ ...row.manifest,
    videos: [video(800, [1001, 1002])] });
  const result = await observeHandoffImport({ handoff: multi,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [{ ...observed(800, [1001, 1002]),
        episodeIds: [1001, 1001] }] }) });
  assert.deepEqual(result, { state: 'awaiting_shoko', episodeId: 1001 });
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

test('offline handoff accepts only Shoko’s exact imported Offline Importer link', async () => {
  const payload = { IDs: { AniDB: 1001 }, Files: [{ ID: 1800, Size: 123,
    IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
    Release: { ID: 'offline://42-1001', ProviderName: 'Offline Importer',
      IsCorrupted: false, CrossReferences: [{ AnidbAnimeID: 42,
        AnidbEpisodeID: 1001, PercentageStart: 0, PercentageEnd: 100 }] },
    Locations: [{ FileID: 1800, IsAccessible: true,
      AbsolutePath: '/pure/Anime/Example/01.mkv' }] }] };
  const readEpisode = ({ anidbId, episodeId }) => readShokoEpisodeFiles({
    baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic',
    anidbId, episodeId, purpose: 'handoff',
    fetchImpl: async () => Response.json(payload),
  });
  assert.deepEqual(await observeHandoffPlacement({ handoff: offlineRow,
    readEpisode, libraryRoot: '/pure/Anime' }),
  { state: 'shoko_library_location_reported', fileIds: [1800] });
  payload.Files[0].Release.ID = 'offline://42-1002';
  assert.notEqual((await observeHandoffImport({ handoff: offlineRow,
    readEpisode })).state, 'shoko_files_identified');
  payload.Files[0].Release = {
    ID: `anidb://${'A'.repeat(32)}+123`, ProviderName: 'AniDB',
    ReleaseURI: 'https://anidb.net/file/800', FileSize: 123,
    IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
    CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
      PercentageStart: null, PercentageEnd: null }],
  };
  assert.deepEqual(await observeHandoffPlacement({ handoff: offlineRow,
    readEpisode, libraryRoot: '/pure/Anime' }),
  { state: 'shoko_library_location_reported', fileIds: [1800] });
});

test('offline content observation after uncertain publish does not claim the rename', async () => {
  const unknown = { ...offlineRow, status: 'publish_unknown',
    publishName: `negev-7-${offlineRow.evidenceDigest.slice(0, 16)}` };
  let writes = 0;
  const result = await reconcileHandoffContent({ attemptId: 7,
    ledger: { getHandoff: () => unknown,
      recordContentPresent: ({ fileIds }) => { writes++;
        return { state: 'content_present', publicationProven: false, fileIds }; } },
    nowMs: 500, readEpisode: async () => ({ state: 'ok', complete: true,
      files: [{ ...observed(800, [1001]), anidbFileId: null,
        releaseEvidence: 'shoko_offline_link', releaseId: 'offline://42-1001' }] }) });
  assert.deepEqual(result, { state: 'content_present',
    publicationProven: false, fileIds: [1800] });
  assert.equal(writes, 1);
});
