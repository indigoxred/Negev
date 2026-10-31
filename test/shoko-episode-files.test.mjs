import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoEpisodeFiles } from '../src/availability/shoko-episode-files.mjs';

const digest = 'A'.repeat(32);
const release = { ID: `anidb://${digest}+123`, ProviderName: 'AniDB',
  ReleaseURI: 'https://anidb.net/file/800', FileSize: 123,
  IsCorrupted: false,
  Hashes: [{ Type: 'ED2K', Value: digest }],
  CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
    PercentageStart: null, PercentageEnd: null }] };
const episode = { IDs: { ID: 555, ParentSeries: 99, AniDB: 1001 }, Files: [{ ID: 51, Size: 123,
  IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }], Release: release,
  Locations: [{ ID: 70, FileID: 51, ManagedFolderID: 2,
    AbsolutePath: '/pure/Anime/Example/01.mkv', IsAccessible: true }] }] };
const json = (value) => new Response(JSON.stringify(value), { status: 200 });
const base = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key',
  anidbId: 42, episodeId: 1001 };

test('reads one exact AniDB episode and its registered accessible file', async () => {
  const result = await readShokoEpisodeFiles({ ...base, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/api/v3/Episode/AniDB/1001/Episode');
    assert.equal(url.searchParams.get('includeFiles'), 'true');
    assert.equal(url.searchParams.get('includeReleaseInfo'), 'true');
    assert.equal(url.searchParams.get('includeXRefs'), 'true');
    assert.equal(url.searchParams.get('includeAbsolutePaths'), 'true');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
    return json(episode);
  } });
  assert.deepEqual(result, { state: 'ok', complete: true,
    shokoEpisodeId: 555, shokoSeriesId: 99, tmdbMovieIds: [], files: [{
    fileId: 51, anidbFileId: 800, ed2k: digest, anidbId: 42, episodeIds: [1001],
    coverage: [{ episodeId: 1001, start: 0, end: 100 }],
    size: 123, sourcePaths: ['/pure/Anime/Example/01.mkv'],
  }] });
});

test('missing local episode and empty local file list stay distinct', async () => {
  const missing = await readShokoEpisodeFiles({ ...base,
    fetchImpl: async () => new Response('', { status: 404 }) });
  assert.deepEqual(missing, { state: 'not_imported' });
  const empty = await readShokoEpisodeFiles({ ...base,
    fetchImpl: async () => json({ IDs: { ID: 555, ParentSeries: 99,
      AniDB: 1001 }, Files: [] }) });
  assert.deepEqual(empty, { state: 'ok', complete: true,
    shokoEpisodeId: 555, shokoSeriesId: 99, tmdbMovieIds: [], files: [] });
});

test('wrong identity, inaccessible location, and unregistered release hold the observation', async () => {
  for (const changed of [
    { ...episode, IDs: { AniDB: 1002 } },
    { ...episode, Files: [{ ...episode.Files[0], Locations: [{
      ...episode.Files[0].Locations[0], IsAccessible: false }] }] },
    { ...episode, Files: [{ ...episode.Files[0], Release: {
      ...release, ProviderName: 'User' } }] },
    { ...episode, Files: [{ ...episode.Files[0], Release: {
      ...release, IsCorrupted: true } }] },
    { ...episode, Files: [{ ...episode.Files[0], Release: {
      ...release, IsCorrupted: undefined } }] },
  ]) {
    const result = await readShokoEpisodeFiles({ ...base, fetchImpl: async () => json(changed) });
    assert.equal(result.state, 'unavailable');
  }
});

test('one accessible location remains usable when an old location is inaccessible', async () => {
  const old = { ID: 71, FileID: 51, ManagedFolderID: 1,
    AbsolutePath: '/pure/Import/old.mkv', IsAccessible: false };
  const result = await readShokoEpisodeFiles({ ...base,
    fetchImpl: async () => json({ ...episode, Files: [{ ...episode.Files[0],
      Locations: [old, ...episode.Files[0].Locations] }] }) });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.files[0].sourcePaths, ['/pure/Anime/Example/01.mkv']);
});

test('one unregistered sibling does not hide a registered playable file', async () => {
  const unregistered = { ...episode.Files[0], ID: 52, Release: {
    ...release, ProviderName: 'User' } };
  const result = await readShokoEpisodeFiles({ ...base,
    fetchImpl: async () => json({ ...episode,
      Files: [unregistered, episode.Files[0]] }) });
  assert.equal(result.state, 'ok');
  assert.equal(result.complete, false);
  assert.deepEqual(result.files.map((file) => file.fileId), [51]);
});
