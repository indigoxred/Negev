import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

const origin = 'http://localhost:3000';
const auth = (cookie, csrfToken) => ({ cookie, origin, 'x-negev-csrf': csrfToken });
const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) });

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
    nowMs = 300_100;
    linked = true;
    assert.deepEqual(await service.tickShokoRecentDrain(),
      { state: 'acknowledged', fileId: 11 });
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42,
      episodeId: 1001 }), [11]);
    assert.deepEqual(reads, ['/api/v3/File', '/api/v3/File',
      '/api/v3/File/11', '/api/v3/File/11']);
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
