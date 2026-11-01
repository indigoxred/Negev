import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserService } from '../src/web/user-service.mjs';

test('opt-in file tick joins a Shoko import to its exact public Plex part', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-user-file-proof-'));
  let service;
  try {
    await mkdir(path.join(root, 'Anime'));
    await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
    const file = { ID: 51, Updated: '2026-11-02T00:00:00Z',
      Size: 5, IsIgnored: false,
      SeriesIDs: [{ SeriesID: { ID: 99, AniDB: 42 },
        EpisodeIDs: [{ ID: 555, AniDB: 1001, TMDB: { Movie: [] } }] }],
      Locations: [{ FileID: 51, IsAccessible: true,
        AbsolutePath: '/pure/Anime/one.mkv' }],
      Release: { ID: null, ProviderName: 'User', IsCorrupted: false,
        CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
          PercentageStart: 0, PercentageEnd: 100 }] } };
    const calls = [];
    service = await createUserService({
      dbPath: path.join(root, 'state.sqlite'),
      shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic',
      sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000',
      secureCookies: false, now: () => 100,
      plex: { plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic',
        publicSections: { episode: [102], movie: [] },
        shokoMount: { appRoot: '/pure', localRoot: root },
        plexMount: { appRoot: '/source-pure', localRoot: root } },
      fetchImpl: async (url, init) => {
        assert.equal(init.method, 'GET');
        calls.push(url.pathname);
        if (url.pathname === '/api/v3/File') return Response.json({
          Total: 1, List: [file] });
        if (url.pathname === '/api/v3/File/51') return Response.json(file);
        if (url.pathname === '/api/v3/Series/AniDB/42') return Response.json({
          ID: 42, Title: 'Example', Type: 'TV' });
        if (url.pathname === '/api/v3/Series/AniDB/42/Episode') return Response.json({
          Total: 1, List: [{ ID: 1001, AnimeID: 42, EpisodeNumber: 1,
            Type: 'Normal', Title: 'One' }] });
        if (url.pathname === '/library/sections/102') return Response.json({
          MediaContainer: { librarySectionID: 102, Directory: [{ type: '4',
            key: '/library/sections/102/all?type=4' }] } });
        if (url.pathname === '/library/sections/102/all') return Response.json({
          MediaContainer: { librarySectionID: 102, offset: 0,
            totalSize: 1, size: 1, Metadata: [{ ratingKey: '500',
              type: 'episode', librarySectionID: 102,
              guid: 'tv.plex.agents.custom.shoko://episode/e555',
              grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
              Media: [{ Part: [{ id: 900, size: 5,
                file: '/source-pure/Anime/one.mkv' }] }] }] } });
        if (url.pathname === '/library/metadata/500') return Response.json({
          MediaContainer: { size: 1, Metadata: [{ ratingKey: '500',
            type: 'episode', librarySectionID: 102,
            guid: 'tv.plex.agents.custom.shoko://episode/e555',
            grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
            Media: [{ Part: [{ id: 900, size: 5,
              file: '/source-pure/Anime/one.mkv' }] }] }] } });
        throw Error(`Unexpected GET ${url.pathname}`);
      },
    });
    assert.equal((await service.tickShokoInventory()).state, 'recorded');
    assert.equal((await service.tickPublicPlexPage({ libraryId: 102,
      kind: 'episode' })).state, 'page_indexed');
    assert.deepEqual(await service.tickFileAvailability(), { state: 'checked',
      target: { anidbId: 42, episodeId: 1001 }, result: 'available',
      batchSize: 1, load: { cardReads: 1, physicalProbes: 1 } });
    assert.equal(service.getDirectAvailabilityStatus({ anidbId: 42,
      episodeId: 1001 }).state, 'available');
    assert.equal(calls.includes('/api/v3/Episode/AniDB/1001/Episode'), false);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
