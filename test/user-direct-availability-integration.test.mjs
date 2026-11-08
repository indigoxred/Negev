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
    const importRoot = path.join(root, 'Import');
    await mkdir(importRoot);
    await writeFile(path.join(importRoot, 'known.mkv'), 'known');
    await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
    const dbPath = path.join(root, 'negev.sqlite');
    const accounts = openAccountLedger(dbPath);
    await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
    accounts.close();
    const digest = 'A'.repeat(32);
    let linked = true;
    let deleted = false;
    let queueCalls = 0;
    const fetchImpl = async (url) => {
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Queue') {
        queueCalls++;
        return Response.json({ WaitingCount: 0, BlockedCount: 0,
          ScheduledCount: 0, TotalCount: 0,
          CurrentlyExecuting: [], Pools: [] });
      }
      if (url.hostname === 'shoko' &&
          url.pathname === '/api/v3/ManagedFolder/1/File') {
        return Response.json({ Total: 1, List: [{ ID: 17, Size: 5,
          SeriesIDs: [{ ID: 42 }], Locations: [{ ManagedFolderID: 1,
            RelativePath: 'known.mkv', IsAccessible: true }] }] });
      }
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/File/51') {
        if (deleted) return new Response(null, { status: 404 });
        return Response.json({ ID: 51, Updated: linked
          ? '2026-10-31T00:00:00Z' : '2026-10-31T00:01:00Z',
        SeriesIDs: linked ? [{ SeriesID: { AniDB: 42 },
          EpisodeIDs: [{ AniDB: 1001 }] }] : [] });
      }
      if (url.hostname === 'shoko' && url.pathname === '/api/v3/Series/AniDB/42') {
        return Response.json({ ID: 42, Title: 'Example', Type: 'TV',
          AirDate: '2020-01-01', EndDate: '2020-02-01',
          EpisodeCount: 1, Restricted: false });
      }
      if (url.hostname === 'shoko' &&
          url.pathname === '/api/v3/Series/AniDB/42/Episode') {
        return Response.json({ Total: 1, List: [{ ID: 1001, AnimeID: 42,
          EpisodeNumber: 1, Type: 'Episode', Title: 'One',
          AirDate: '2020-01-01' }] });
      }
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
      shokoImportRoot: importRoot,
      shokoImportFolderId: 1,
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
    assert.deepEqual((await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } })).json().items, []);
    assert.deepEqual((await service.app.inject({ method: 'GET', url: target,
      headers: { cookie } })).json().state, 'unknown');
    const session = await service.app.inject({ method: 'GET',
      url: '/api/session', headers: { cookie } });
    const created = await service.app.inject({ method: 'POST',
      url: '/api/requests', headers: { cookie,
        origin: 'http://localhost:3000',
        'x-negev-csrf': session.json().csrfToken },
      payload: { anidbId: 42, scope: 'installment', requestKey: 'direct-check' } });
    assert.equal(created.statusCode, 202, created.body);
    assert.deepEqual(await service.refreshShokoFile(51),
      { state: 'recorded_file', fileId: 51 });
    assert.deepEqual(service.getDirectAvailabilityStatus({
      anidbId: 42, episodeId: 1001 }), { state: 'unknown' });
    assert.equal((await service.tickPublicPlexPage({ libraryId: 102,
      kind: 'episode' })).state, 'page_indexed');
    assert.deepEqual(await service.tickDirectAvailability(), {
      state: 'checked', target: { anidbId: 42, episodeId: 1001 },
      result: 'available' });
    assert.equal(service.getDirectAvailabilityStatus({
      anidbId: 42, episodeId: 1001 }).state, 'available');
    const detailWithPlayable = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/42', headers: { cookie } });
    assert.equal(detailWithPlayable.json().episodes[0].availability, 'available');
    assert.equal(session.json().capabilities.availabilityChecks, true);
    const pending = path.join(importRoot, 'pending.mkv');
    await writeFile(pending, 'partial import');
    const probeUrl = `/api/requests/${created.json().requestId}/presence-probe`;
    const probe = () => service.app.inject({ method: 'POST', url: probeUrl,
      headers: { cookie, origin: 'http://localhost:3000',
        'x-negev-csrf': session.json().csrfToken },
      payload: { episodeIds: [1001] } });
    const importDiagnostic = () => service.app.inject({ method: 'POST',
      url: '/api/admin/import-activity',
      headers: { cookie, origin: 'http://localhost:3000',
        'x-negev-csrf': session.json().csrfToken }, payload: {} });
    assert.deepEqual((await importDiagnostic()).json(), {
      state: 'import_activity', activity: 'busy',
      reason: 'unrecognized_import_video',
      acquisitionAuthorized: false });
    assert.equal((await probe()).statusCode, 200);
    assert.equal(queueCalls, 0, 'Import file is observed before reading Shoko queue');
    await rm(pending);
    assert.equal((await probe()).statusCode, 200);
    assert.equal(queueCalls, 2,
      'recognized Import files permit two bounded queue checks');
    assert.deepEqual((await importDiagnostic()).json(), {
      state: 'import_activity', activity: 'quiet_observed',
      acquisitionAuthorized: false });
    const history = await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } });
    assert.equal(history.json().items[0].progress.publicAvailability,
      'verified_recently');
    assert.equal(history.json().items[0].progress.publicVerifiedTargets, 1);
    linked = false;
    assert.equal((await service.refreshShokoFile(51)).state, 'recorded_file');
    assert.deepEqual(service.getDirectAvailabilityStatus({
      anidbId: 42, episodeId: 1001 }), { state: 'unknown' });
    const detailAfterUnlink = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/42', headers: { cookie } });
    assert.equal(detailAfterUnlink.json().episodes[0].availability, 'unknown');
    const withdrawn = await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } });
    assert.equal(withdrawn.json().items[0].progress.publicAvailability,
      'unverified');
    assert.deepEqual(await service.tickDirectAvailability(), {
      state: 'checked', target: { anidbId: 42, episodeId: 1001 },
      result: 'unknown' });
    assert.deepEqual((await service.app.inject({ method: 'GET', url: target,
      headers: { cookie } })).json(), { state: 'unknown',
      reason: 'evidence_incomplete' });
    linked = true;
    assert.equal((await service.refreshShokoFile(51)).state, 'recorded_file');
    assert.equal((await service.tickDirectAvailability()).result, 'available');
    deleted = true;
    assert.deepEqual(service.acceptShokoEvent('file:deleted', [{ FileID: 51 }]),
      { state: 'queued', fileId: 51 });
    assert.deepEqual(service.getDirectAvailabilityStatus({
      anidbId: 42, episodeId: 1001 }), { state: 'unknown' });
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
