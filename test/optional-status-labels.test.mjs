import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openFileProofLedger } from '../src/availability/file-proof-ledger.mjs';
import { createUserService, primeSavedScope } from './helpers/scoped-user-service.mjs';

for (const source of ['display', 'title_dump', 'timeout']) test(`durable Requests returns cold status and keeps optional English behavior: ${source}`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-optional-label-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const accounts = openAccountLedger(dbPath);
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: owner.id, requestKey: 'saved', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, title: 'Saved title', kind: 'series', episodeIds: [99], monitorFuture: false } });
  requests.close();
  let finish, reads = 0;
  const stalled = new Promise(resolve => { finish = resolve; });
  const service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.invalid',
    shokoApiKey: 'synthetic', sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000', secureCookies: false,
    anidbTitleDump: source === 'title_dump',
    fetchImpl: async url => {
      if (String(url) === 'https://anidb.net/api/anime-titles.dat.gz') {
        await stalled;
        return new Response(gzipSync('# aid|type|language|title\n42|1|x-jat|Saved title\n42|4|en|English label\n'));
      }
      if (String(url) === 'https://animap.id/api/anidb/42') { reads++; await stalled;
        if (source === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
        return Response.json({ anidb_id: 42, title: 'Saved title', title_english: 'English label', restricted: false, tags: [] }); }
      return Response.json({});
    } });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'http://localhost:3000' }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = () => service.app.inject({ method: 'GET', url: '/api/requests', headers: { cookie } });
    const cold = read();
    const first = await Promise.race([cold, new Promise(resolve => setTimeout(() => resolve(null), 200))]);
    finish();
    await cold;
    assert.notEqual(first, null, 'saved status must not wait for the optional provider');
    assert.equal(first.json().items[0].englishTitle, null);
    await new Promise(resolve => setImmediate(resolve));
    const warm = await read();
    assert.equal(warm.json().items[0].englishTitle, source === 'timeout' ? null : 'English label');
    assert.equal(reads, 1);
  } finally { finish(); await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Library durable proof responds before optional English enrichment and keeps its warm label', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-library-label-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const accounts = openAccountLedger(dbPath);
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  accounts.close();
  primeSavedScope({ dbPath, localRoot: dir });
  const proofs = openFileProofLedger(dbPath, { now: () => 1000, positiveLifetimeMs: 1800000 });
  proofs.observe({ anidbId: 42, episodeId: 99, checkedMs: 1000,
    proof: { fileId: 1, libraryId: 102, ratingKey: 1, partId: 1 } });
  proofs.close();
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const service = await createUserService({ dbPath, shokoBaseUrl: 'http://shoko.internal:8111',
    shokoApiKey: 'synthetic', sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000', secureCookies: false,
    now: () => 1000, fileProofLifetimeMs: 1800000,
    plex: { plexBaseUrl: 'http://plex.internal:32400', plexToken: 'synthetic',
      publicSections: { episode: [102], movie: [] }, shokoMount: { appRoot: '/pure', localRoot: dir },
      plexMounts: [{ appRoot: '/source-pure', localRoot: dir }] },
    fetchImpl: async url => {
      if (String(url) === 'https://animap.id/api/anidb/42') { await blocked;
        return Response.json({ anidb_id: 42, title: 'Saved title', title_english: 'English library label', restricted: false, tags: [] }); }
      return Response.json({});
    } });
  try {
    const login = await service.app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'http://localhost:3000' }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = () => service.app.inject({ method: 'GET', url: '/api/library', headers: { cookie } });
    const pending = read();
    const first = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 200))]);
    finish(); await pending;
    assert.notEqual(first, null);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().items[0].englishTitle, null);
    assert.equal(first.json().items[0].verifiedEpisodeCount, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await read()).json().items[0].englishTitle, 'English library label');
  } finally { finish(); await service.close(); await rm(dir, { recursive: true, force: true }); }
});
