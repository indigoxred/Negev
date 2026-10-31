import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCatalogueTestService } from '../src/catalogue/catalogue-service.mjs';

const token = 'synthetic-private-token';
const auth = { authorization: `Bearer ${token}` };
const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) });

test('search to one metadata refresh to later exact detail uses a single isolated service', async () => {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-service-'));
  let detailReady = false;
  const methods = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    methods.push(`${init.method} ${parsed.pathname}`);
    if (parsed.pathname.endsWith('/Search')) return json({ Total: 1, List: [{ ID: 1234, Title: 'Example' }] });
    if (parsed.pathname.endsWith('/Refresh')) return { status: 200, text: async () => 'false' };
    if (parsed.pathname.endsWith('/Episode')) return json({ Total: 1, List: [
      { ID: 1001, AnimeID: 1234, EpisodeNumber: 1, Type: 'Episode', Title: 'First' }] });
    if (parsed.pathname.endsWith('/AniDB/1234')) return detailReady
      ? json({ ID: 1234, Title: 'Example', Type: 'TV' }) : { status: 404 };
    throw Error('Unexpected Shoko request');
  };
  const service = createCatalogueTestService({
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    dbPath: path.join(dir, 'claims.sqlite'), testToken: token, fetchImpl,
    now: () => 1_000_000_000,
  });
  try {
    const unseen = await service.app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(unseen.statusCode, 409);
    assert.deepEqual(methods, []);
    const search = await service.app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example', headers: auth });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().items[0].anidbId, 1234);
    const read = await service.app.inject({ method: 'GET', url: '/api/catalogue/1234', headers: auth });
    assert.equal(read.json().state, 'detail_pending');
    assert.equal(methods.filter((entry) => entry.startsWith('POST ')).length, 0);
    const load = await service.app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(load.statusCode, 202);
    assert.equal(load.json().reason, 'refresh_queued');
    const repeat = await service.app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(repeat.statusCode, 202);
    assert.equal(repeat.json().reason, 'active_refresh');
    assert.equal(methods.filter((entry) => entry.endsWith('/Refresh')).length, 1);
    detailReady = true;
    const ready = await service.app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().state, 'detail_ready');
    assert.equal(ready.json().requestable, false);
    assert.equal(ready.json().detail.episodes[0].id, 1001);
    assert.equal(methods.filter((entry) => entry.endsWith('/Refresh')).length, 1);
  } finally {
    await service.close();
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
});
