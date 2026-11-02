import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openFileProofLedger } from '../src/availability/file-proof-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

test('opt-in file tick joins a Shoko import to its exact public Plex part', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-user-file-proof-'));
  let service;
  try {
    await mkdir(path.join(root, 'Anime'));
    await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
    const dbPath = path.join(root, 'state.sqlite');
    const accounts = openAccountLedger(dbPath, { now: () => 100 });
    const owner = await accounts.bootstrapAdmin({ username: 'Owner',
      password: 'long-owner-passphrase' });
    accounts.close();
    const requests = openRequestLedger(dbPath);
    requests.submit({ requesterId: owner.id, requestKey: 'example', nowMs: 90,
      intent: { state: 'ready', anidbId: 42, kind: 'series',
        monitorFuture: false, episodeIds: [1001] } });
    requests.close();
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
      dbPath,
      shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic',
      sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000',
      secureCookies: false, now: () => 100,
      shokoInventoryHints: true, fileBackfill: true,
      fileProofLifetimeMs: 30 * 60_000,
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
    assert.equal((await service.tickFileBackfill()).state, 'checked');
    const proofs = openFileProofLedger(dbPath, {
      positiveLifetimeMs: 30 * 60_000, now: () => 100 });
    try {
      assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
        'available');
      const login = await service.app.inject({ method: 'POST', url: '/api/login',
        headers: { origin: 'http://localhost:3000' },
        payload: { username: 'Owner', password: 'long-owner-passphrase' } });
      const cookie = login.headers['set-cookie'].split(';')[0];
      const coverage = async () => (await service.app.inject({ method: 'GET',
        url: '/api/requests', headers: { cookie } })).json()
        .items[0].progress.publicVerifiedTargets;
      const catalogue = async () => (await service.app.inject({ method: 'GET',
        url: '/api/catalogue/42', headers: { cookie } })).json();
      assert.equal(await coverage(), 1);
      assert.equal((await catalogue()).episodes?.[0]?.availability, 'available');
      const db = new DatabaseSync(dbPath);
      const source = db.prepare(`SELECT updated,observed_ms AS observedMs
        FROM shoko_inventory_files WHERE file_id=51`).get();
      const card = db.prepare(`SELECT observed_ms AS observedMs,
        identity_signature AS identitySignature FROM plex_card_observations
        WHERE library_id=102 AND rating_key=500`).get();
      const part = db.prepare(`SELECT candidate_key AS storageKey
        FROM plex_part_candidates WHERE library_id=102 AND rating_key=500
          AND part_id=900`).get();
      db.close();
      assert.deepEqual(service.acceptShokoEvent('file:deleted', [{ FileID: 51 }]),
        { state: 'queued', fileId: 51 });
      assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
        'unknown');
      assert.equal(await coverage(), undefined);
      assert.equal((await catalogue()).episodes?.[0]?.availability, 'unknown');
      assert.deepEqual(proofs.observeGuarded({ anidbId: 42, episodeId: 1001,
        proof: { fileId: 51, libraryId: 102, ratingKey: 500, partId: 900,
          storageKey: part.storageKey },
        revision: { source, card }, checkedMs: 100 }),
      { state: 'held', reason: 'source_generation_changed' });
      assert.equal((await service.refreshShokoFile(51)).state, 'recorded_file');
      const reopened = new DatabaseSync(dbPath);
      try {
        assert.equal(reopened.prepare(`SELECT state FROM shoko_inventory_files
          WHERE file_id=51`).get().state, 'linked');
      } finally { reopened.close(); }
    } finally { proofs.close(); }
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
