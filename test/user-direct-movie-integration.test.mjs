import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

async function checkDirectMovie(plexGuid, expected) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-direct-movie-'));
  let service;
  try {
    await mkdir(path.join(root, 'Anime'));
    await writeFile(path.join(root, 'Anime', 'film.mkv'), 'video');
    const dbPath = path.join(root, 'negev.sqlite');
    const accounts = openAccountLedger(dbPath);
    await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
    accounts.close();
    const digest = 'B'.repeat(32);
    const fetchImpl = async (url) => {
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/File/51') {
        return Response.json({ ID: 51, Updated: '2026-10-31T00:00:00Z',
          SeriesIDs: [{ SeriesID: { AniDB: 42 },
            EpisodeIDs: [{ AniDB: 1001 }] }] });
      }
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Series/AniDB/42') {
        return Response.json({ ID: 42, Title: 'Example Film', Type: 'Movie',
          AirDate: '2020-01-01', EndDate: '2020-01-01',
          EpisodeCount: 1, Restricted: false });
      }
      if (url.hostname === 'shoko' &&
          url.pathname === '/api/v3/Series/AniDB/42/Episode') {
        return Response.json({ Total: 1, List: [{ ID: 1001, AnimeID: 42,
          EpisodeNumber: 1, Type: 'Episode', Title: 'Film',
          AirDate: '2020-01-01' }] });
      }
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Series/AniDB/Search') {
        return Response.json({ Total: 1, List: [{ ID: 42, Title: 'Example Film' }] });
      }
      if (url.hostname === 'shoko' &&
          url.pathname === '/api/v3/Episode/AniDB/1001/Episode') {
        return Response.json({ IDs: { ID: 555, ParentSeries: 99,
          AniDB: 1001, TMDB: { Movie: [777] } },
        Files: [{ ID: 51, Size: 5, IsIgnored: false,
          Hashes: [{ Type: 'ED2K', Value: digest }],
          Release: { ID: `anidb://${digest}+5`, ProviderName: 'AniDB',
            ReleaseURI: 'https://anidb.net/file/800', FileSize: 5,
            IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: digest }],
            CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
              PercentageStart: null, PercentageEnd: null }] },
          Locations: [{ FileID: 51, IsAccessible: true,
            AbsolutePath: '/pure/Anime/film.mkv' }] }] });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/sections/123') {
        return Response.json({ MediaContainer: { librarySectionID: 123,
          Directory: [{ type: '1', key: '/library/sections/123/all?type=1' }] } });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/sections/123/all') {
        return Response.json({ MediaContainer: { librarySectionID: 123,
          offset: 0, totalSize: 1, size: 1,
          Metadata: [{ ratingKey: 500, type: 'movie', librarySectionID: 123 }] } });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/metadata/500') {
        return Response.json({ MediaContainer: { size: 1,
          Metadata: [{ ratingKey: 500, librarySectionID: 123,
            type: 'movie', guid: plexGuid,
            Media: [{ Part: [{ id: 900, size: 5,
              file: '/source-pure/Anime/film.mkv' }] }] }] } });
      }
      return new Response(null, { status: 404 });
    };
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko:8111/',
      shokoApiKey: 'synthetic', sessionKey: randomBytes(32),
      publicOrigin: 'http://localhost:3000', secureCookies: false,
      plex: { plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic',
        publicSections: { episode: [], movie: [123] },
        shokoMount: { appRoot: '/pure', localRoot: root },
        plexMounts: [{ appRoot: '/source-pure', localRoot: root }] },
      fetchImpl });
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: 'http://localhost:3000' },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    assert.deepEqual((await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } })).json().items, []);
    assert.deepEqual(await service.refreshShokoFile(51),
      { state: 'recorded_file', fileId: 51 });
    assert.equal((await service.tickPublicPlexPage({ libraryId: 123,
      kind: 'movie' })).state, 'page_indexed');
    assert.deepEqual(await service.tickDirectAvailability(), {
      state: 'checked', target: { anidbId: 42, episodeId: 1001 },
      result: expected });
    const detail = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/42', headers: { cookie } });
    assert.equal(detail.json().kind, 'movie');
    assert.equal(detail.json().episodes[0].availability, expected);
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a direct Shoko anime movie reaches public Plex status without a request',
  async () => checkDirectMovie('tmdb://777', 'available'));

test('the same movie bytes under another TMDB card do not assert availability',
  async () => checkDirectMovie('tmdb://778', 'unknown'));
