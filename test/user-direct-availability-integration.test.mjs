import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

test('a signed-in user sees a manual Shoko import only after exact public Plex discovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-direct-status-'));
  let service;
  try {
    await mkdir(path.join(root, 'Anime'));
    await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
    const dbPath = path.join(root, 'negev.sqlite');
    const accounts = openAccountLedger(dbPath);
    await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
    accounts.close();
    const digest = 'A'.repeat(32);
    const fetchImpl = async (url) => {
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Series/AniDB/Search') {
        return Response.json({ Total: 1, List: [{ ID: 42, Title: 'Example' }] });
      }
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Episode/AniDB/1001/Episode') {
        return Response.json({ IDs: { ID: 555, ParentSeries: 99, AniDB: 1001 },
          Files: [{ ID: 51, Size: 5, IsIgnored: false,
            Hashes: [{ Type: 'ED2K', Value: digest }],
            Release: { ID: `anidb://${digest}+5`, ProviderName: 'AniDB',
              ReleaseURI: 'https://anidb.net/file/800', FileSize: 5,
              IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: digest }],
              CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
                PercentageStart: null, PercentageEnd: null }] },
            Locations: [{ FileID: 51, IsAccessible: true,
              AbsolutePath: '/pure/Anime/one.mkv' }] }] });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/sections/102') {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/sections/102/all') {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          offset: 0, totalSize: 1, size: 1,
          Metadata: [{ ratingKey: 500, type: 'episode', librarySectionID: 102 }] } });
      }
      if (url.hostname === 'plex' && url.pathname === '/library/metadata/500') {
        return Response.json({ MediaContainer: { size: 1,
          Metadata: [{ ratingKey: 500, librarySectionID: 102,
            type: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e555',
            grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
            Media: [{ Part: [{ id: 900, size: 5,
              file: '/source-pure/Anime/one.mkv' }] }] }] } });
      }
      return new Response(null, { status: 404 });
    };
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko:8111/',
      shokoApiKey: 'synthetic', sessionKey: randomBytes(32),
      publicOrigin: 'http://localhost:3000', secureCookies: false,
      plex: { plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic',
        publicSections: { episode: [102], movie: [] },
        shokoMount: { appRoot: '/pure', localRoot: root },
        plexMounts: [{ appRoot: '/source-pure', localRoot: root }] },
      fetchImpl });
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: 'http://localhost:3000' },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const target = '/api/catalogue/42/episodes/1001/availability?kind=series';
    assert.equal((await service.app.inject({ method: 'GET', url: target })).statusCode, 401);
    assert.equal((await service.app.inject({ method: 'GET', url: target,
      headers: { cookie } })).statusCode, 404);
    const search = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Example', headers: { cookie } });
    assert.equal(search.statusCode, 200);
    assert.deepEqual((await service.app.inject({ method: 'GET', url: target,
      headers: { cookie } })).json().state, 'unknown');
    assert.equal((await service.tickPublicPlexPage({ libraryId: 102,
      kind: 'episode' })).state, 'page_indexed');
    assert.deepEqual((await service.app.inject({ method: 'GET', url: target,
      headers: { cookie } })).json(), { state: 'available' });
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
