import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlexAvailabilityService } from '../src/availability/plex-availability-service.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));
const digest = 'A'.repeat(32);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-plex-service-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'Anime'), { recursive: true });
  await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === 'plex' && url.pathname === '/library/sections/102') {
      return Response.json({ MediaContainer: { librarySectionID: 102,
        Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } });
    }
    if (url.hostname === 'plex' && url.pathname === '/library/sections/102/all') {
      return Response.json({ MediaContainer: { librarySectionID: 102, offset: 0,
        totalSize: 1, size: 1, Metadata: [{ ratingKey: '500', type: 'episode',
          librarySectionID: 102 }] } });
    }
    if (url.hostname === 'plex' && url.pathname === '/library/metadata/500') {
      return Response.json({ MediaContainer: { size: 1, Metadata: [{
        ratingKey: '500', type: 'episode', librarySectionID: 102,
        Media: [{ Part: [{ id: 900, size: 5,
          file: '/source-pure/Anime/one.mkv' }] }],
      }] } });
    }
    if (url.hostname === 'shoko' && url.pathname ===
        '/api/v3/Episode/AniDB/1001/Episode') {
      return Response.json({ IDs: { AniDB: 1001 }, Files: [{ ID: 51,
        Size: 5, IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }],
        Release: { ID: `anidb://${digest}+5`, ProviderName: 'AniDB',
          ReleaseURI: 'https://anidb.net/file/800', FileSize: 5,
          IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: digest }],
          CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
            PercentageStart: null, PercentageEnd: null }] },
        Locations: [{ FileID: 51, IsAccessible: true,
          AbsolutePath: '/pure/Anime/one.mkv' }],
      }] });
    }
    return new Response(null, { status: 404 });
  };
  const config = { dbPath: path.join(root, 'negev.sqlite'),
    shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic',
    plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic',
    publicSections: { episode: [102], movie: [] },
    shokoMount: { appRoot: '/pure', localRoot: root },
    plexMount: { appRoot: '/source-pure', localRoot: root },
    fetchImpl, now: () => 100 };
  return { config, calls };
}

test('a direct Shoko import becomes Available only after public Plex card discovery', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
  assert.deepEqual(await service.observeTarget(target),
    { state: 'unknown', reason: 'card_discovery_incomplete' });
  assert.deepEqual(await service.tick({ libraryId: 102, kind: 'episode' }),
    { state: 'page_indexed', processed: 1, nextOffset: 0 });
  assert.deepEqual(await service.observeTarget(target),
    { state: 'available', fileId: 51 });
  assert.equal(calls.filter((call) => call === 'plex/library/metadata/500').length, 2);
  service.close();
});

test('unlisted private library cannot be scanned by the public observer', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.tick({ libraryId: 103, kind: 'episode' }),
    { state: 'held', reason: 'library_not_allowed' });
  assert.deepEqual(calls, []);
  service.close();
});
