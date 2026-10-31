import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCatalogueTestService } from '../src/catalogue/catalogue-service.mjs';

const auth = { authorization: 'Bearer synthetic-private-token' };
const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) });

test('private search to exact held request never dispatches acquisition', async () => {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-private-request-'));
  let airDate = '2026-10-01';
  let restricted = false;
  const methods = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    methods.push(`${init.method} ${parsed.pathname}`);
    if (parsed.pathname.endsWith('/Search')) return json({ Total: 1, List: [{ ID: 1234, Title: 'Example' }] });
    if (parsed.pathname.endsWith('/Episode')) return json({ Total: 1, List: [
      { ID: 1001, AnimeID: 1234, EpisodeNumber: 1, Type: 'Episode',
        Title: 'First', AirDate: '2026-10-01' }] });
    if (parsed.pathname.endsWith('/AniDB/1234')) return json({ ID: 1234,
      Title: 'Example', Type: 'TV', AirDate: airDate, EndDate: null,
      EpisodeCount: 2, Restricted: restricted });
    throw Error('Unexpected provider request');
  };
  const service = createCatalogueTestService({
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    dbPath: path.join(dir, 'state.sqlite'), testToken: 'synthetic-private-token',
    fetchImpl, now: () => 1_000_000_000, today: () => '2026-10-31',
  });
  try {
    const body = { anidbId: 1234, scope: 'installment', requestKey: 'submission-1' };
    const unseen = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: body });
    assert.equal(unseen.statusCode, 409);
    assert.deepEqual(methods, []);
    await service.app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example', headers: auth });
    const created = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: body });
    assert.equal(created.statusCode, 202);
    assert.equal(created.json().state, 'held');
    assert.equal(created.json().created, true);
    const requestId = created.json().requestId;
    const retry = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: body });
    assert.equal(retry.json().requestId, requestId);
    assert.equal(retry.json().created, false);
    const saved = await service.app.inject({ method: 'GET', url: `/api/requests/${requestId}`,
      headers: auth });
    assert.deepEqual(saved.json().episodeIds, [1001]);
    assert.equal(saved.json().monitorFuture, true);
    assert.equal(methods.every((entry) => entry.startsWith('GET ')), true);
    const forged = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: { ...body, requestKey: 'forged', releaseState: 'completed', requesterId: 999 } });
    assert.equal(forged.statusCode, 400);
    const wrong = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: { ...body, requestKey: 'wrong', scope: 'episodes', episodeIds: [9999] } });
    assert.equal(wrong.statusCode, 409);
    airDate = null;
    const unknown = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: { ...body, requestKey: 'unknown' } });
    assert.equal(unknown.statusCode, 409);
    assert.equal(unknown.json().reason, 'release_state_unknown');
    airDate = '2026-10-01';
    restricted = true;
    const blocked = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: { ...body, requestKey: 'restricted' } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().reason, 'restricted_or_unverified');
  } finally {
    await service.close();
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a movie request is saved as one-time held acquisition', async () => {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-private-movie-'));
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/Search')) return json({ Total: 1, List: [{ ID: 2345, Title: 'Example Movie' }] });
    if (route.endsWith('/Episode')) return json({ Total: 1, List: [
      { ID: 2001, AnimeID: 2345, EpisodeNumber: 1, Type: 'Episode',
        Title: 'Movie', AirDate: '2026-01-01' }] });
    if (route.endsWith('/AniDB/2345')) return json({ ID: 2345, Title: 'Example Movie',
      Type: 'Movie', AirDate: '2026-01-01', EndDate: null,
      EpisodeCount: 1, Restricted: false });
    throw Error('Unexpected provider request');
  };
  const service = createCatalogueTestService({
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    dbPath: path.join(dir, 'state.sqlite'), testToken: 'synthetic-private-token',
    fetchImpl, now: () => 1_000_000_000, today: () => '2026-10-31',
  });
  try {
    await service.app.inject({ method: 'GET', url: '/api/catalogue/search?q=Movie', headers: auth });
    const created = await service.app.inject({ method: 'POST', url: '/api/requests',
      headers: auth, payload: { anidbId: 2345, scope: 'installment', requestKey: 'movie-1' } });
    assert.equal(created.statusCode, 202);
    const saved = await service.app.inject({ method: 'GET',
      url: `/api/requests/${created.json().requestId}`, headers: auth });
    assert.equal(saved.json().kind, 'movie');
    assert.deepEqual(saved.json().episodeIds, [2001]);
    assert.equal(saved.json().monitorFuture, false);
  } finally {
    await service.close();
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
});
