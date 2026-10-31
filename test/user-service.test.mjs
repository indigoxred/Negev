import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

const origin = 'http://localhost:3000';
const auth = (cookie, csrfToken) => ({ cookie, origin, 'x-negev-csrf': csrfToken });
const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) });

test('signed-in user searches AniDB and saves an exact held request across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-service-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const methods = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    methods.push(`${init.method} ${parsed.pathname}`);
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
      return json({ Total: 1, List: [{ ID: 1001, AnimeID: 1234,
        EpisodeNumber: 1, Type: 'Episode', Title: 'First', AirDate: '2026-10-01' }] });
    }
    if (parsed.pathname.endsWith('/AniDB/1234')) {
      return json({ ID: 1234, Title: 'Example Series', Type: 'TV',
        AirDate: '2026-10-01', EndDate: null, EpisodeCount: 2, Restricted: false });
    }
    if (parsed.pathname.endsWith('/AniDB/2345')) {
      return json({ ID: 2345, Title: 'Example Movie', Type: 'Movie',
        AirDate: '2026-01-01', EndDate: null, EpisodeCount: 1, Restricted: false });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };
  const config = { dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
    shokoApiKey: 'synthetic-shoko-key', sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false, fetchImpl,
    now: () => 1_000, today: () => '2026-10-31' };
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
    const created = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth(cookie, csrf),
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'once' } });
    assert.equal(created.statusCode, 202, `${created.body} ${JSON.stringify(methods)}`);
    const id = created.json().requestId;
    const read = await service.app.inject({ method: 'GET', url: `/api/requests/${id}`,
      headers: { cookie } });
    assert.deepEqual(read.json().episodeIds, [1001]);
    assert.equal(read.json().requesterId, owner.id);
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
    assert.equal(methods.every((method) => method.startsWith('GET ')), true);
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
        assert.equal(url.pathname, '/api/v3/File');
        assert.equal(init.method, 'GET');
        return json({ Total: 1, List: [{ ID: 10, Updated: '2026-10-31T00:00:00Z',
          SeriesIDs: [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [{ AniDB: 1001 }] }] }] });
      } });
    assert.equal((await service.tickShokoInventory()).state, 'recorded');
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(calls, 1);
    await service.close();
    service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
      shokoApiKey: 'synthetic-key', sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false,
      fetchImpl: async () => { throw new Error('No scan on startup'); } });
    assert.deepEqual(service.getObservedShokoFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(calls, 1);
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
