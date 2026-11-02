import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openShokoInventoryLedger } from '../src/availability/shoko-inventory-worker.mjs';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { openTitleCheckLedger } from '../src/availability/title-check-ledger.mjs';
import { openFileProofLedger } from '../src/availability/file-proof-ledger.mjs';
import { openDirectAvailabilityQueue } from '../src/availability/direct-availability-queue.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

const origin = 'http://localhost:3000';
const auth = (cookie, csrfToken) => ({ cookie, origin, 'x-negev-csrf': csrfToken });
const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) });

test('internal first-time observation uses installed Shoko, Plex and Import readers without acquisition', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-first-time-service-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const importRoot = path.join(dir, 'Import');
  await mkdir(importRoot);
  let clock = 100;
  let connectionState = 'connected';
  const reads = [];
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111/', shokoApiKey: 'synthetic',
    shokoImportRoot: importRoot, shokoImportFolderId: 1,
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    readShokoConnectionState: () => ({ state: connectionState }),
    waitForImportQuiet: async (ms) => { clock += ms; },
    now: () => clock,
    plex: { plexBaseUrl: 'http://plex.internal:32400/',
      plexToken: 'synthetic', publicSections: { episode: [102], movie: [] },
      sourcePolicy: [{ libraryId: 102, type: 'show',
        agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series',
        roots: ['/anime-native/Relay'] }],
      shokoMount: { appRoot: '/pure', localRoot: dir },
      plexMount: { appRoot: '/source-pure', localRoot: dir } },
    prowlarr: { baseUrl: 'http://prowlarr.internal:9696/',
      apiKey: 'synthetic', indexerIds: [1] },
    fetchImpl: async (url, init) => {
      reads.push(url.pathname);
      assert.equal(init.method, 'GET');
      if (url.pathname === '/api/v3/Episode/AniDB/1001/Episode') {
        return new Response(null, { status: 404 });
      }
      if (url.pathname === '/api/v3/Episode/AniDB/1001') {
        return Response.json({ ID: 1001, AnimeID: 42 });
      }
      if (url.pathname === '/api/v3/Queue') {
        return Response.json({ WaitingCount: 0, BlockedCount: 0,
          ScheduledCount: 0, TotalCount: 0, CurrentlyExecuting: [], Pools: [] });
      }
      if (url.pathname === '/library/sections') {
        return Response.json({ MediaContainer: { size: 1, Directory: [{
          key: '102', type: 'show', agent: 'tv.plex.agents.custom.shoko',
          scanner: 'Plex TV Series',
          Location: [{ path: '/anime-native/Relay' }],
        }] } });
      }
      if (url.pathname === '/library/sections/102') {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          Directory: [{ type: '4',
            key: '/library/sections/102/all?type=4' }] } });
      }
      if (url.pathname === '/library/sections/102/all') {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          offset: 0, totalSize: 0, size: 0 } });
      }
      throw new Error(`Unexpected read: ${url.pathname}`);
    },
  });
  try {
    const snapshot = await service.observeFirstTimeUncertain({
      anidbId: 42, episodeIds: [1001], kind: 'series' });
    assert.equal(snapshot?.anidbId, 42, JSON.stringify({ snapshot, reads }));
    assert.equal(snapshot.shoko.state, 'unimported_targets');
    assert.equal(snapshot.plex.state, 'healthy_unconfirmed');
    assert.equal(snapshot.plex.complete, false);
    assert.equal(snapshot.plex.probeCoverage, 'health_only');
    assert.equal(snapshot.plex.sourceVerified, true);
    assert.equal(snapshot.importFence.state, 'quiet_window_observed');
    assert.equal(reads.filter((path) => path === '/api/v3/Queue').length, 2);
    assert.equal(reads.filter((path) => path === '/library/sections/102/all').length, 2);
    assert.equal(reads.some((path) => /torrent|download|prowlarr/i.test(path)), false);
    service.flagShokoReconciliation('feed_disconnected');
    connectionState = 'disconnected';
    const queueReads = reads.filter((path) => path === '/api/v3/Queue').length;
    assert.deepEqual(await service.observeFirstTimeUncertain({
      anidbId: 42, episodeIds: [1001], kind: 'series' }),
    { state: 'held', reason: 'import_quiet_window_unverified' });
    assert.equal(reads.filter((path) => path === '/api/v3/Queue').length,
      queueReads);
    connectionState = 'connected';
    service.flagShokoReconciliation('feed_reconnected');
    const afterReconnect = await service.observeFirstTimeUncertain({
      anidbId: 42, episodeIds: [1001], kind: 'series' });
    assert.equal(afterReconnect?.importFence?.state, 'quiet_window_observed');
    const workerOptions = {
      qbBaseUrl: 'http://qb.internal:8080/',
      sessionGate: { get: async () => { throw Error('no login'); },
        invalidate: () => {} },
      stagingHostPath: path.join(dir, 'staging'),
      holdingRoot: path.join(dir, 'holding'),
      importRoot: path.join(importRoot, 'Negev'),
      inspectMounts: async () => { throw Error('no mount read'); },
      realpathImpl: async () => { throw Error('no path read'); },
      shokoProviderId: '11111111-2222-4333-8444-555555555555',
    };
    assert.throws(() => service.openAcquisitionWorkers({
      ...workerOptions, importRoot }), TypeError);
    assert.throws(() => service.openAcquisitionWorkers({
      ...workerOptions, importRoot: path.join(dir, 'Anime') }), TypeError);
    assert.throws(() => service.openAcquisitionWorkers({
      ...workerOptions, holdingRoot: path.join(importRoot, 'holding') }), TypeError);
    const runtime = service.openAcquisitionWorkers(workerOptions);
    assert.equal((await runtime.start()).state, 'reconciled');
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.equal(reads.filter((path) => /torrent|download|prowlarr/i.test(path)).length, 0);
    await service.close();
    assert.equal(runtime.getStatus().state, 'stopped');
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('account service exposes an empty, admin-only operational review', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-review-service-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-shoko-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    now: () => 1_000,
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner',
        password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const review = await service.app.inject({ method: 'GET',
      url: '/api/admin/review', headers: { cookie } });
    assert.equal(review.statusCode, 200, review.body);
    assert.deepEqual(review.json(), { state: 'review', items: [],
      nextAfterAttemptId: null });
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opt-in AniDB dump search finds an unowned title and marks stale results', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-title-search-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let dumpAvailable = true;
  let shokoSearches = 0;
  let time = 1_000;
  const dump = gzipSync('# aid|type|language|title\n4158|1|x-jat|Pale Cocoon\n');
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-shoko-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    anidbTitleDump: true, now: () => time,
    fetchImpl: async (url) => {
      if (String(url) === 'https://anidb.net/api/anime-titles.dat.gz') {
        return new Response(dumpAvailable ? dump : null,
          { status: dumpAvailable ? 200 : 503 });
      }
      shokoSearches++;
      return json({ Total: 1, List: [{ ID: 1234, Title: 'Shoko Fallback' }] });
    },
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const broad = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Pale', headers: { cookie } });
    assert.equal(broad.statusCode, 200, broad.body);
    assert.equal(broad.json().items[0].anidbId, 4158);
    assert.equal(broad.json().catalogueSource, 'anidb_dump');
    assert.equal(shokoSearches, 0);
    dumpAvailable = false;
    time += 86_400_000;
    const stale = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Pale', headers: { cookie } });
    assert.equal(stale.json().items[0].anidbId, 4158);
    assert.equal(stale.json().catalogueSource, 'anidb_dump');
    assert.equal(stale.json().catalogueStale, true);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a first-load AniDB dump failure falls back to bounded Shoko search', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-title-fallback-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const paths = [];
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-shoko-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    anidbTitleDump: true, now: () => 1_000,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return String(url).startsWith('https://anidb.net/')
        ? new Response(null, { status: 503 })
        : json({ Total: 1, List: [{ ID: 1234, Title: 'Shoko Fallback' }] });
    },
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const search = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Fallback', headers: { cookie } });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().items[0].anidbId, 1234);
    assert.equal(search.json().catalogueSource, 'shoko_cache');
    assert.deepEqual(paths, ['/api/anime-titles.dat.gz',
      '/api/v3/Series/AniDB/Search']);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a slow AniDB title refresh does not occupy the Shoko metadata slot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-title-load-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let finishDump;
  let dumpStarted;
  const started = new Promise((resolve) => { dumpStarted = resolve; });
  const pending = new Promise((resolve) => { finishDump = resolve; });
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-shoko-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    anidbTitleDump: true, now: () => 1_000,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/anime-titles.dat.gz') {
        dumpStarted();
        return pending;
      }
      if (pathname === '/api/v3/Series/AniDB/1234') return json({
        ID: 1234, Title: 'Example Series', Type: 'TV', AirDate: '2026-01-01',
        EndDate: null, EpisodeCount: 1, Restricted: false,
      });
      if (pathname.endsWith('/Episode')) return json({ Total: 1,
        List: [{ ID: 1001, AnimeID: 1234, EpisodeNumber: 1,
          Type: 'Episode', Title: 'First', AirDate: '2026-01-01' }] });
      throw new Error('Unexpected provider request');
    },
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const search = service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Pale', headers: { cookie } });
    await started;
    const detail = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/1234', headers: { cookie } });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().state, 'details');
    finishDump(new Response(gzipSync('4158|1|x-jat|Pale Cocoon\n')));
    assert.equal((await search).statusCode, 200);
  } finally {
    finishDump?.(new Response(null, { status: 503 }));
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('signed-in user searches AniDB and saves an exact held request across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-service-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const methods = [];
  let showSecond = false;
  let showSpecial = false;
  let calendarDay = '2026-10-31';
  const videoName = 'Example Series - 01.mkv';
  const info = Buffer.from(`d6:lengthi1000e4:name${Buffer.byteLength(videoName)}:${videoName}12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae`);
  const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const proxy = 'http://prowlarr.internal:9696/7/download?apikey=synthetic-prowlarr-key&link=abc123&file=Example';
  const movieName = 'Example Movie.mkv';
  const movieInfo = Buffer.from(`d6:lengthi1200e4:name${Buffer.byteLength(movieName)}:${movieName}12:piece lengthi16384e6:pieces20:bbbbbbbbbbbbbbbbbbbbe`);
  const movieTorrent = Buffer.concat([Buffer.from('d4:info'), movieInfo, Buffer.from('e')]);
  const movieProxy = 'http://prowlarr.internal:9696/7/download?apikey=synthetic-prowlarr-key&link=def456&file=Movie';
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    methods.push(`${init.method} ${parsed.pathname}`);
    if (parsed.pathname === '/api/v1/search') {
      assert.equal(init.headers['X-Api-Key'], 'synthetic-prowlarr-key');
      if (parsed.searchParams.get('query') === 'Example Movie') {
        return json([{ guid: 'synthetic-movie', indexerId: 7,
          title: 'Example Movie', size: 1200, protocol: 'torrent',
          seeders: 2, downloadUrl: movieProxy }]);
      }
      return json([{ guid: 'synthetic-release', indexerId: 7,
        title: 'Example Series 01', size: 1000, protocol: 'torrent',
        seeders: 3, downloadUrl: proxy }]);
    }
    if (parsed.pathname === '/7/download') {
      return new Response(parsed.searchParams.get('link') === 'def456'
        ? movieTorrent : torrent, { headers: {
        'content-type': 'application/x-bittorrent' } });
    }
    if (parsed.pathname.endsWith('/Search')) {
      return parsed.searchParams.get('query') === 'Movie'
        ? json({ Total: 1, List: [{ ID: 2345, Title: 'Example Movie' }] })
        : json({ Total: 1, List: [{ ID: 1234, Title: 'Example Series' }] });
    }
    if (parsed.pathname.endsWith('/AniDB/2345/Episode')) {
      return json({ Total: 1, List: [{ ID: 2001, AnimeID: 2345,
        EpisodeNumber: 1, Type: 'Episode', Title: 'Movie', AirDate: '2026-01-01' }] });
    }
    if (parsed.pathname.endsWith('/Episode')) {
      return json({ Total: 1 + Number(showSecond) + Number(showSpecial),
        List: [{ ID: 1001, AnimeID: 1234,
          EpisodeNumber: 1, Type: 'Episode', Title: 'First', AirDate: '2026-10-01' },
        ...(showSecond ? [{ ID: 1002, AnimeID: 1234, EpisodeNumber: 2,
          Type: 'Episode', Title: 'Second', AirDate: '2026-11-01' }] : []),
        ...(showSpecial ? [{ ID: 1099, AnimeID: 1234, EpisodeNumber: 1,
          Type: 'Special', Title: 'Extra', AirDate: '2026-10-01' }] : [])] });
    }
    if (parsed.pathname.endsWith('/AniDB/1234')) {
      return json({ ID: 1234, Title: 'Example Series', Type: 'TV',
        AirDate: '2026-09-01', EndDate: null, EpisodeCount: 2, Restricted: false });
    }
    if (parsed.pathname.endsWith('/AniDB/2345')) {
      return json({ ID: 2345, Title: 'Example Movie', Type: 'Movie',
        AirDate: '2026-01-01', EndDate: null, EpisodeCount: 1, Restricted: false });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };
  const config = { dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
    shokoApiKey: 'synthetic-shoko-key', sessionKey: randomBytes(32),
    prowlarr: { baseUrl: 'http://prowlarr.internal:9696',
      apiKey: 'synthetic-prowlarr-key', indexerIds: [7] },
    publicOrigin: origin, secureCookies: false, fetchImpl,
    now: () => 1_000, today: () => calendarDay };
  let service;
  try {
    service = await createUserService(config);
    const login = await service.app.inject({ method: 'POST', url: '/api/login', headers: { origin },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await service.app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const csrf = session.json().csrfToken;
    const unseen = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf),
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'once' } });
    assert.equal(unseen.statusCode, 409);
    assert.deepEqual(methods, []);
    const search = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Example', headers: { cookie } });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().items[0].anidbId, 1234);
    const beforeHydration = methods.length;
    const disabledHydration = await service.app.inject({ method: 'POST',
      url: '/api/catalogue/1234/load-detail', headers: auth(cookie, csrf),
      payload: {} });
    assert.equal(disabledHydration.statusCode, 503);
    assert.equal(methods.length, beforeHydration);
    const created = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf),
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'once' } });
    assert.equal(created.statusCode, 202, `${created.body} ${JSON.stringify(methods)}`);
    const id = created.json().requestId;
    const read = await service.app.inject({ method: 'GET', url: `/api/requests/${id}`,
      headers: { cookie } });
    assert.deepEqual(read.json().episodeIds, [1001]);
    assert.equal(read.json().requesterId, owner.id);
    assert.equal(read.json().monitorFuture, true);
    const history = await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } });
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json().items[0].progress, { state: 'saved',
      targetCount: 1, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
    const candidates = await service.app.inject({ method: 'GET',
      url: `/api/requests/${id}/candidates`, headers: { cookie } });
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.equal(candidates.json().items[0].evidence, 'unverified');
    assert.equal(methods.some((method) => method === 'GET /api/v1/search'), true);
    const inspected = await service.app.inject({ method: 'POST',
      url: `/api/requests/${id}/preflight`, headers: auth(cookie, csrf),
      payload: { candidate: { guid: 'synthetic-release', indexerId: 7,
        title: 'Example Series 01', size: 1000 } } });
    assert.equal(inspected.statusCode, 200, inspected.body);
    assert.equal(inspected.json().registeredInAniDb, false);
    assert.equal(inspected.json().downloadStarted, false);
    assert.deepEqual(inspected.json().episodeIds, [1001]);
    assert.equal(methods.filter((method) => method === 'GET /7/download').length, 1);
    showSecond = true;
    calendarDay = '2026-11-01';
    const airing = await service.pollAiringNextPage();
    assert.equal(airing.state, 'page');
    assert.equal(airing.afterId, 0);
    assert.equal(airing.results.length, 1);
    const afterAir = await service.app.inject({ method: 'GET',
      url: `/api/requests/${id}`, headers: { cookie } });
    assert.deepEqual(afterAir.json().episodeIds, [1001, 1002]);
    showSpecial = true;
    const special = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf), payload: { anidbId: 1234,
        scope: 'episodes', episodeIds: [1099], requestKey: 'special-once' } });
    assert.equal(special.statusCode, 202, special.body);
    const specialRead = await service.app.inject({ method: 'GET',
      url: `/api/requests/${special.json().requestId}`, headers: { cookie } });
    assert.deepEqual(specialRead.json().episodeIds, [1099]);
    assert.equal(specialRead.json().monitorFuture, false);
    const movieSearch = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Movie', headers: { cookie } });
    assert.equal(movieSearch.statusCode, 200, movieSearch.body);
    const movie = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf),
      payload: { anidbId: 2345, scope: 'installment', requestKey: 'movie-once' } });
    assert.equal(movie.statusCode, 202, movie.body);
    const movieRead = await service.app.inject({ method: 'GET',
      url: `/api/requests/${movie.json().requestId}`, headers: { cookie } });
    assert.equal(movieRead.json().kind, 'movie');
    assert.equal(movieRead.json().monitorFuture, false);
    assert.deepEqual(movieRead.json().episodeIds, [2001]);
    const movieCandidates = await service.app.inject({ method: 'GET',
      url: `/api/requests/${movie.json().requestId}/candidates`,
      headers: { cookie } });
    assert.equal(movieCandidates.statusCode, 200, movieCandidates.body);
    assert.equal(movieCandidates.json().items[0].guid, 'synthetic-movie');
    const movieInspected = await service.app.inject({ method: 'POST',
      url: `/api/requests/${movie.json().requestId}/preflight`,
      headers: auth(cookie, csrf), payload: { candidate: {
        guid: 'synthetic-movie', indexerId: 7,
        title: 'Example Movie', size: 1200 } } });
    assert.equal(movieInspected.statusCode, 200, movieInspected.body);
    assert.deepEqual(movieInspected.json().episodeIds, [2001]);
    assert.deepEqual(movieInspected.json().files[0].episodeIds, [2001]);
    assert.equal(movieInspected.json().downloadStarted, false);
    assert.equal(methods.every((method) => method.startsWith('GET ')), true);
    calendarDay = '2026-09-30';
    const future = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf), payload: { anidbId: 1234,
        scope: 'installment', requestKey: 'future-only' } });
    assert.equal(future.statusCode, 202, future.body);
    assert.deepEqual(future.json().targetIds, []);
    const futureRead = await service.app.inject({ method: 'GET',
      url: `/api/requests/${future.json().requestId}`, headers: { cookie } });
    assert.deepEqual(futureRead.json().episodeIds, []);
    assert.equal(futureRead.json().monitorFuture, true);
    const futureHistory = await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } });
    assert.deepEqual(futureHistory.json().items[0].progress, { state: 'saved',
      targetCount: 0, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
    await service.close();
    service = await createUserService({ ...config, fetchImpl: async () => {
      throw new Error('Catalogue must not be read on identical retry');
    } });
    const relogin = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const secondCookie = relogin.headers['set-cookie'].split(';')[0];
    const secondSession = await service.app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: secondCookie } });
    const retry = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(secondCookie, secondSession.json().csrfToken),
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'once' } });
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(retry.json().requestId, id);
    assert.equal(retry.json().created, false);
  } finally {
    await service?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent catalogue reads do not pile up on Shoko', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-load-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  let service;
  try {
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false,
      fetchImpl: async () => {
        calls++;
        started();
        return new Promise((resolve) => { release = resolve; });
      } });
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const first = service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Example', headers: { cookie } });
    await entered;
    const busy = await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Another', headers: { cookie } });
    assert.equal(busy.statusCode, 503);
    assert.equal(calls, 1);
    assert.deepEqual(await service.tickShokoInventory(),
      { state: 'held', reason: 'file_page_unavailable' });
    assert.equal(calls, 1);
    release(json({ Total: 0, List: [] }));
    assert.equal((await first).statusCode, 200);
  } finally {
    await service?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('account service records one Shoko direct-import page without dispatching acquisition', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-inventory-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let service;
  let calls = 0;
  try {
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false, fetchImpl: async (url, init) => {
        calls++;
        assert.equal(init.method, 'GET');
        if (url.pathname === '/api/v3/File/10') return json({ ID: 10,
          Updated: '2026-10-31T00:00:00Z', SeriesIDs: [{ SeriesID: { AniDB: 42 },
            EpisodeIDs: [{ AniDB: 1001 }] }] });
        assert.equal(url.pathname, '/api/v3/File');
        return json({ Total: 1, List: [{ ID: 10, Updated: '2026-10-31T00:00:00Z',
          SeriesIDs: [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [{ AniDB: 1001 }] }] }] });
      } });
    assert.deepEqual(await service.tickShokoRecentScan(),
      { state: 'held', reason: 'recent_observer_disabled' });
    assert.equal(calls, 0);
    assert.equal((await service.tickShokoInventory()).state, 'recorded');
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(calls, 1);
    assert.deepEqual(await service.refreshShokoFile(10),
      { state: 'recorded_file', fileId: 10 });
    assert.equal(calls, 2);
    assert.deepEqual(await service.refreshShokoFile(0),
      { state: 'held', reason: 'invalid_file_id' });
    assert.equal(calls, 2);
    assert.deepEqual(service.acceptShokoEvent('file:hashed', [{ FileID: 10 }]),
      { state: 'queued', fileId: 10 });
    service.flagShokoReconciliation('feed_started');
    await service.close();
    assert.equal(calls, 3);
    assert.equal(service.getShokoEventState().reconciliationNeeded, true);
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false,
      fetchImpl: async () => { throw new Error('No scan on startup'); } });
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(calls, 3);
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a busy account metadata slot keeps a new direct-import target due', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-direct-busy-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let unblock;
  let entered;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let service;
  try {
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
      sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
      now: () => 100,
      plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
        publicSections: { episode: [102], movie: [] },
        shokoMount: { appRoot: '/pure', localRoot: dir },
        plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
      fetchImpl: async (url) => {
        if (url.pathname === '/api/v3/File') return json({ Total: 1,
          List: [{ ID: 10, Updated: '2026-10-31T00:00:00Z',
            SeriesIDs: [{ SeriesID: { AniDB: 42 },
              EpisodeIDs: [{ AniDB: 1001 }] }] }] });
        if (url.hostname === 'plex.internal') {
          entered();
          await blocked;
          return new Response(null, { status: 503 });
        }
        throw new Error(`Unexpected metadata read: ${url.pathname}`);
      },
    });
    assert.equal((await service.tickShokoInventory()).state, 'recorded');
    const plexRead = service.tickPublicPlexPage({ libraryId: 102, kind: 'episode' });
    await started;
    assert.deepEqual(await service.tickDirectAvailability(),
      { state: 'held', reason: 'metadata_busy' });
    unblock();
    await plexRead;
    assert.deepEqual(service.getDirectAvailabilityStatus({ anidbId: 42,
      episodeId: 1001 }), { state: 'unknown' });
    const retry = await service.tickDirectAvailability();
    assert.equal(retry.state, 'checked');
    assert.deepEqual(retry.target, { anidbId: 42, episodeId: 1001 });
  } finally {
    unblock();
    await service?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a busy detail lookup keeps a file-fallback target due', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-file-fallback-busy-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let unblock;
  let entered;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let service;
  try {
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
      sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
      now: () => 100,
      plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
        publicSections: { episode: [102], movie: [] },
        shokoMount: { appRoot: '/pure', localRoot: dir },
        plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
      fetchImpl: async (url) => {
        if (url.hostname === 'plex.internal') {
          entered();
          await blocked;
          return new Response(null, { status: 503 });
        }
        throw new Error(`Unexpected metadata read: ${url.pathname}`);
      },
    });
    const queue = openDirectAvailabilityQueue(dbPath);
    try { queue.enqueue({ anidbId: 42, episodeId: 1001, observedMs: 100 }); }
    finally { queue.close(); }
    const plexRead = service.tickPublicPlexPage({ libraryId: 102, kind: 'episode' });
    await started;
    assert.deepEqual(await service.tickFileAvailability(),
      { state: 'held', reason: 'metadata_busy' });
    unblock();
    await plexRead;
    const retry = await service.tickFileAvailability();
    assert.equal(retry.state, 'checked');
    assert.deepEqual(retry.target, { anidbId: 42, episodeId: 1001 });
  } finally {
    unblock();
    await service?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('opt-in inventory hints stay private in the durable Shoko ledger', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-hint-inventory-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let service;
  try {
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false,
      shokoInventoryHints: true, fetchImpl: async (url) => {
        assert.equal(url.pathname, '/api/v3/File');
        assert.deepEqual(url.searchParams.getAll('include'),
          ['XRefs,AbsolutePaths,ImportLimbo']);
        return json({ Total: 1, List: [{ ID: 10, Size: 5,
          Updated: '2026-10-31T00:00:00Z',
          Locations: [{ FileID: 10, IsAccessible: true,
            AbsolutePath: '/pure/Anime/episode.mkv' }],
          SeriesIDs: [{ SeriesID: { AniDB: 42 },
            EpisodeIDs: [{ AniDB: 1001 }] }] }] });
      } });
    assert.equal((await service.tickShokoInventory()).state, 'recorded');
    const ledger = openShokoInventoryLedger(dbPath);
    try {
      assert.deepEqual(ledger.getFileHint(10), {
        updated: '2026-10-31T00:00:00Z', size: 5,
        sourcePaths: ['/pure/Anime/episode.mkv'], observedMs: ledger.getFile(10).observedMs });
    } finally { ledger.close(); }
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opt-in recent import resumes a saved cursor and waits for Shoko recognition', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-recent-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const baseline = { fileId: 10, importedNs:
    String(BigInt(Date.parse('2026-10-31T00:00:10Z')) * 1_000_000n) };
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const recent = openShokoRecentLedger(dbPath);
  recent.bootstrap(baseline);
  recent.close();
  let service;
  let linked = false;
  let nowMs = 100;
  const reads = [];
  try {
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false, shokoRecent: true,
      readShokoConnectionState: () => ({ state: 'connected' }),
      now: () => nowMs,
      fetchImpl: async (url, init) => {
        reads.push(url.pathname);
        assert.equal(init.method, 'GET');
        if (url.pathname === '/api/v3/File') {
          assert.equal(url.searchParams.get('sortOrder'), '-ImportedAt,-FileID');
          return json({ Total: 2, List: [
            { ID: 11, Imported: '2026-10-31T00:00:11Z' },
            { ID: 10, Imported: '2026-10-31T00:00:10Z' },
          ] });
        }
        assert.equal(url.pathname, '/api/v3/File/11');
        return json({ ID: 11, Updated: linked
          ? '2026-10-31T00:01:00Z' : '2026-10-31T00:00:11Z',
        SeriesIDs: linked ? [{ SeriesID: { AniDB: 42 },
          EpisodeIDs: [{ AniDB: 1001 }] }] : [] });
      } });
    assert.deepEqual(reads, []);
    assert.deepEqual(await service.tickShokoRecentScan(),
      { state: 'caught_up', added: 1 });
    assert.deepEqual(await service.tickShokoRecentDrain(),
      { state: 'retry_scheduled', fileId: 11 });
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42,
      episodeId: 1001 }), []);
    const pendingPath = { ManagedFolderID: 1, RelativePath: 'new/11.mkv' };
    service.acceptShokoEvent('file:detected', [pendingPath]);
    assert.equal(service.getImportFeedState().state, 'unverified');
    service.acceptShokoEvent('file:hashed', [{ ...pendingPath, FileID: 11 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(service.getShokoArrivalState(),
      { state: 'busy', pendingPaths: 1 });
    nowMs = 300_100;
    linked = true;
    assert.deepEqual(await service.tickShokoRecentDrain(),
      { state: 'acknowledged', fileId: 11 });
    assert.deepEqual(service.getShokoArrivalState(),
      { state: 'unverified', pendingPaths: 0 });
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42,
      episodeId: 1001 }), [11]);
    assert.equal(service.getShokoEventState().reconciliationNeeded, true);
    assert.deepEqual(await service.tickShokoRecentScan(),
      { state: 'caught_up', added: 0 });
    assert.equal(service.getShokoEventState().reconciliationNeeded, false);
    assert.equal(service.getImportFeedState().state, 'connected');
    service.flagShokoReconciliation('feed_disconnected');
    assert.deepEqual(await service.tickShokoRecentScan(),
      { state: 'caught_up', added: 0 });
    assert.equal(service.getShokoEventState().reconciliationNeeded, true);
    assert.equal(service.getShokoEventState().fullReconciliationNeeded, true);
    assert.equal(service.getImportFeedState().state, 'unverified');
    assert.deepEqual(reads, ['/api/v3/File', '/api/v3/File',
      '/api/v3/File/11', '/api/v3/File/11', '/api/v3/File/11',
      '/api/v3/File', '/api/v3/File', '/api/v3/File', '/api/v3/File']);
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('recent import without an operator baseline cannot read Shoko or advance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-recent-empty-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let service;
  let reads = 0;
  try {
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false, shokoRecent: true,
      fetchImpl: async () => { reads++; throw new Error('unexpected Shoko read'); } });
    assert.deepEqual(await service.tickShokoRecentScan(),
      { state: 'held', reason: 'recent_baseline_required' });
    assert.equal(reads, 0);
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a feed gap clears only after two connected, generation-stable full inventories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-feed-catchup-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let connected = false;
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    readShokoConnectionState: () => ({ state: connected ? 'connected' : 'disconnected' }),
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, '/api/v3/File');
      assert.equal(init.method, 'GET');
      return json({ Total: 0, List: [] });
    } });
  try {
    service.flagShokoReconciliation('feed_disconnected');
    await service.tickShokoInventory();
    await service.tickShokoInventory();
    assert.equal(service.getShokoEventState().fullReconciliationNeeded, true);
    connected = true;
    await service.tickShokoInventory();
    assert.equal(service.getShokoEventState().fullReconciliationNeeded, true);
    service.flagShokoReconciliation('feed_reconnected');
    await service.tickShokoInventory();
    assert.equal(service.getShokoEventState().fullReconciliationNeeded, true);
    await service.tickShokoInventory();
    assert.equal(service.getShokoEventState().fullReconciliationNeeded, false);
    assert.equal(service.getImportFeedState().state, 'connected');
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('service shutdown drains an in-flight inventory page before closing SQLite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-inventory-drain-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
    shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false, fetchImpl: async () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    } });
  try {
    const tick = service.tickShokoInventory();
    await started;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release(json({ Total: 0, List: [] }));
    assert.equal((await tick).state, 'recorded');
    await closing;
    assert.equal(closed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('optional public Plex observer stays inert until an explicit account-service tick', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-plex-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  let calls = 0;
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
      publicSections: { episode: [102], movie: [] },
      shokoMount: { appRoot: '/pure', localRoot: dir },
      plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
    fetchImpl: async () => { calls++; return new Response(null, { status: 503 }); } });
  try {
    assert.equal(calls, 0);
    assert.deepEqual(await service.tickPublicPlexPage({ libraryId: 103, kind: 'episode' }),
      { state: 'held', reason: 'library_not_allowed' });
    assert.equal(calls, 0);
    assert.deepEqual(await service.tickPublicPlexPage({ libraryId: 102, kind: 'episode' }),
      { state: 'held', reason: 'key_page_unavailable' });
    assert.equal(calls, 1);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opt-in title check survives the HTTP action and advances by explicit ticks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-title-check-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  await accounts.bootstrapAdmin({ username: 'Owner',
    password: 'long-owner-passphrase' });
  accounts.close();
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    titleCheck: true, now: () => 1_000,
    plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
      publicSections: { episode: [102], movie: [] },
      shokoMount: { appRoot: '/pure', localRoot: dir },
      plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
    fetchImpl: async (url) => {
      if (url.pathname === '/api/v3/Series/AniDB/Search') {
        return json({ Total: 1, List: [{ ID: 42, Title: 'Example' }] });
      }
      if (url.pathname === '/api/v3/Series/AniDB/42') {
        return json({ ID: 42, Title: 'Example', Type: 'Movie' });
      }
      if (url.pathname === '/api/v3/Series/AniDB/42/Episode') {
        return json({ Total: 1, List: [{ ID: 1001, AnimeID: 42,
          EpisodeNumber: 1, Type: 'Episode', Title: 'One' }] });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner',
        password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await service.app.inject({ method: 'GET',
      url: '/api/session', headers: { cookie } });
    assert.equal(session.json().capabilities.titleChecks, true);
    assert.equal((await service.app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=Example', headers: { cookie } })).statusCode, 200);
    const url = '/api/catalogue/42/title-check';
    const started = await service.app.inject({ method: 'POST', url,
      headers: auth(cookie, session.json().csrfToken), payload: {} });
    assert.equal(started.statusCode, 202, started.body);
    assert.deepEqual(await service.tickTitleCheck(),
      { state: 'page_loaded', anidbId: 42, page: 1 });
    assert.deepEqual(await service.tickTitleCheck(),
      { state: 'target_checked', anidbId: 42,
        episodeId: 1001, result: 'unknown' });
    assert.deepEqual((await service.app.inject({ method: 'GET', url,
      headers: { cookie } })).json(),
    { state: 'done', generation: 1, totalCount: 1,
      checkedCount: 1, recentAvailableCount: 0,
      lastVerifiedAvailableCount: 0 });
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('request history reflects recent title-check proof and loses it on expiry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-title-progress-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner',
    password: 'long-owner-passphrase' });
  accounts.close();
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: owner.id, requestKey: 'film', nowMs: 900,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      monitorFuture: false, episodeIds: [1001] } });
  requests.close();
  const titles = openTitleCheckLedger(dbPath);
  titles.start({ anidbId: 42, nowMs: 901 });
  const page = titles.claimNext({ nowMs: 902 });
  titles.recordPage({ claim: page, detail: { state: 'details',
    anidbId: 42, kind: 'movie', page: 1, total: 1,
    nextPage: null, episodes: [{ id: 1001 }] }, checkedMs: 903 });
  const target = titles.claimNext({ nowMs: 904 });
  titles.recordTarget({ claim: target, status: 'available', checkedMs: 905 });
  titles.close();
  let clock = 1_000;
  const service = await createUserService({ dbPath,
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    titleCheck: true, now: () => clock,
    plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
      publicSections: { episode: [102], movie: [] },
      shokoMount: { appRoot: '/pure', localRoot: dir },
      plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
    fetchImpl: async () => { throw Error('request history must not scan Plex'); },
  });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner',
        password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = async () => (await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } })).json().items[0].progress;
    assert.equal((await read()).publicVerifiedTargets, 1);
    clock = 30 * 60_000 + 906;
    assert.equal((await read()).publicAvailability, 'unverified');
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opt-in file proof contributes to request progress and expires without Plex reads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-file-progress-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner',
    password: 'long-owner-passphrase' });
  accounts.close();
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: owner.id, requestKey: 'film', nowMs: 900,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      monitorFuture: false, episodeIds: [1001] } });
  requests.close();
  let clock = 1_000;
  let service;
  try {
    const prior = openFileProofLedger(dbPath, {
      positiveLifetimeMs: 30 * 60_000, now: () => clock });
    try {
      prior.observe({ anidbId: 42, episodeId: 1001,
        proof: { fileId: 10, libraryId: 102, ratingKey: 20, partId: 30 },
        checkedMs: 998 });
    } finally { prior.close(); }
    service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
      sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
      shokoInventoryHints: true, fileBackfill: true,
      fileProofLifetimeMs: 30 * 60_000, now: () => clock,
      plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
        publicSections: { episode: [102], movie: [] },
        shokoMount: { appRoot: '/pure', localRoot: dir },
        plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
      fetchImpl: async () => { throw Error('progress must not scan providers'); },
    });
    const login = await service.app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner',
        password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = async () => (await service.app.inject({ method: 'GET',
      url: '/api/requests', headers: { cookie } })).json().items[0].progress;
    assert.equal((await read()).publicAvailability, 'unverified');
    const proof = openFileProofLedger(dbPath, {
      positiveLifetimeMs: 30 * 60_000, now: () => clock });
    try {
      assert.deepEqual(proof.observe({ anidbId: 42, episodeId: 1001,
        proof: { fileId: 10, libraryId: 102, ratingKey: 20, partId: 30 },
        checkedMs: 999 }), { state: 'recorded' });
    } finally { proof.close(); }
    assert.equal((await read()).publicVerifiedTargets, 1);
    assert.equal((await service.tickFileBackfill()).state, 'idle');
    clock = 30 * 60_000 + 1_000;
    assert.equal((await read()).publicAvailability, 'unverified');
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});
