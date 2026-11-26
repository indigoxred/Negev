import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoOneFile } from '../src/availability/shoko-one-file.mjs';
import { readLocalFileRanges } from '../src/availability/shoko-file-ranges.mjs';
import { readPlexItemParts } from '../src/availability/plex-item-parts.mjs';
import { readShokoEpisodeFiles } from '../src/availability/shoko-episode-files.mjs';

const shoko = { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic', anidbId: 42, episodeId: 1001 };
const digest = 'A'.repeat(32);
const release = { ID: null, ProviderName: 'User', IsCorrupted: false,
  CrossReferences: [{ AnidbAnimeID: null, AnidbEpisodeID: 1001, PercentageStart: 0, PercentageEnd: 100 }] };
const file = { ID: 51, Size: 123, IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }],
  Release: release, Locations: [{ FileID: 51, IsAccessible: true, AbsolutePath: '/pure/Anime/01.mkv' }] };
const emptyEpisode = { IDs: { ID: 555, ParentSeries: 99, AniDB: 1001 }, Files: [] };
const userEpisode = { ...emptyEpisode, Files: [file] };
const json = value => Response.json(value);
const rangesInput = { base: new URL(shoko.baseUrl), apiKey: shoko.apiKey, file,
  anidbId: 42, ed2k: digest, timeoutMs: 1000 };
const plexInput = { baseUrl: 'http://plex:32400/', token: 'synthetic', ratingKey: 512,
  expectedType: 'episode', libraryId: 102 };

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('response cleanup blocked observation')), 500);
    })]);
  } finally { clearTimeout(timer); }
}
function openResponse(status, mode = 'normal') {
  let cancels = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('untrusted error body')); },
    cancel() {
      cancels++;
      if (mode === 'pending') return new Promise(() => {});
      if (mode === 'reject') return Promise.reject(Error('synthetic cancellation rejection'));
    },
  }), { status });
  if (mode === 'throw') response.body.cancel = () => {
    cancels++; throw Error('synthetic synchronous cancellation failure');
  };
  return { response, cancels: () => cancels };
}
const scenarios = [
  { name: 'exact Shoko file', expected: () => ({ state: 'unavailable' }),
    run: response => readShokoOneFile({ ...shoko, fileId: 51, fetchImpl: async () => response }) },
  { name: 'local Shoko ranges', expected: () => null,
    run: response => readLocalFileRanges({ ...rangesInput, fetchImpl: async () => response }) },
  { name: 'exact Plex card', expected: status => ({ state: status === 404 ? 'not_found' : 'unavailable' }),
    run: response => readPlexItemParts({ ...plexInput, fetchImpl: async () => response }) },
  { name: 'local Shoko episode', expected: status => status === 404
      ? { state: 'not_imported', anidbId: 42, episodeId: 1001 } : { state: 'unavailable' },
    run: response => readShokoEpisodeFiles({ ...shoko,
      fetchImpl: async url => url.pathname.endsWith('/Episode') ? response : json({ ID: 1001, AnimeID: 42 }) }) },
  { name: 'metadata after missing local episode', expected: status => status === 404
      ? { state: 'metadata_missing', anidbId: 42, episodeId: 1001 } : { state: 'unavailable' },
    run: response => readShokoEpisodeFiles({ ...shoko, purpose: 'first_time',
      fetchImpl: async url => url.pathname.endsWith('/Episode') ? new Response(null, { status: 404 }) : response }) },
  { name: 'metadata after empty local episode', expected: status => status === 404
      ? { state: 'metadata_missing', anidbId: 42, episodeId: 1001 } : { state: 'unavailable' },
    run: response => readShokoEpisodeFiles({ ...shoko, purpose: 'first_time',
      fetchImpl: async url => url.pathname.endsWith('/Episode') ? json(emptyEpisode) : response }) },
  { name: 'unscoped User release metadata', expected: () => ({ state: 'unavailable' }),
    run: response => readShokoEpisodeFiles({ ...shoko, purpose: 'availability',
      fetchImpl: async url => url.pathname.endsWith('/Episode') ? json(userEpisode) : response }) },
];

// Removing cancellation from any rejected-status branch leaves a real open stream behind.
for (const scenario of scenarios) {
  for (const status of [302, 401, 404, 503]) {
    for (const mode of ['normal', 'pending', 'reject', 'throw']) {
      test(`${scenario.name} ${status} disposes rejected body without waiting for ${mode} cancellation`, async () => {
        const fixture = openResponse(status, mode);
        assert.deepEqual(await promptly(scenario.run(fixture.response)), scenario.expected(status));
        assert.equal(fixture.cancels(), 1, 'discarded provider body must be cancelled exactly once');
        assert.equal(fixture.response.body.locked, false);
        await new Promise(resolve => setImmediate(resolve)); // Surface unhandled cancellation rejections.
      });
    }
  }
}

const exactRangeFile = { ...file, Release: { ...release, CrossReferences: [
  { AnidbAnimeID: 42, AnidbEpisodeID: 1001, PercentageStart: 0, PercentageEnd: 0 }] } };
const successCases = [
  { name: 'exact Shoko file', read: response => readShokoOneFile({ ...shoko, fileId: 51, fetchImpl: async () => response }),
    payload: { ID: 51, Updated: '2026-11-26T00:00:00Z', SeriesIDs: [] },
    check: result => assert.equal(result.state, 'file'), limit: 100_000 },
  { name: 'local Shoko ranges', read: response => readLocalFileRanges({ ...rangesInput, file: exactRangeFile, fetchImpl: async () => response }),
    payload: { ...file, SeriesIDs: [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [
      { AniDB: 1001, Source: 'AniDB', Percentage: { Start: 0, End: 100 } }] }] },
    check: result => assert.deepEqual(result.CrossReferences, [
      { AnidbAnimeID: 42, AnidbEpisodeID: 1001, PercentageStart: 0, PercentageEnd: 100 }]), limit: 2_000_000 },
  { name: 'exact Plex card', read: response => readPlexItemParts({ ...plexInput, fetchImpl: async () => response }),
    payload: { MediaContainer: { size: 1, Metadata: [
      { ratingKey: '512', type: 'episode', librarySectionID: 102, Media: [] }] } },
    check: result => assert.deepEqual(result, { state: 'no_parts' }), limit: 2_000_000 },
  { name: 'local Shoko episode', read: response => readShokoEpisodeFiles({ ...shoko, fetchImpl: async () => response }),
    payload: emptyEpisode, check: result => assert.equal(result.state, 'ok'), limit: 2_000_000 },
];
for (const scenario of successCases) {
  test(`${scenario.name} 200 consumes the bounded body without premature cancellation`, async () => {
    let cancels = 0;
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(scenario.payload))); controller.close();
    }, cancel() { cancels++; } }));
    scenario.check(await scenario.read(response));
    assert.equal(response.bodyUsed, true);
    assert.equal(response.body.locked, false);
    assert.equal(cancels, 0);
  });
  for (const declared of [false, true]) {
    test(`${scenario.name} oversized ${declared ? 'declared' : 'streamed'} 200 body retains bounded-reader cleanup`, async () => {
      let cancels = 0;
      const response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(scenario.limit + 1)));
      }, cancel() { cancels++; } }), { headers: declared ? { 'Content-Length': String(scenario.limit + 1) } : {} });
      const result = await promptly(scenario.read(response));
      assert.deepEqual(result, scenario.name === 'local Shoko ranges' ? null : { state: 'unavailable' });
      assert.equal(cancels, 1);
      assert.equal(response.body.locked, false);
    });
  }
}
