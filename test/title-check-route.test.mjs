import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

test('one authenticated title action is CSRF guarded and returns shared progress', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-route-'));
  const accounts = openAccountLedger(path.join(dir, 'accounts.sqlite'),
    { now: () => 100 });
  await accounts.bootstrapAdmin({ username: 'Owner',
    password: 'long-owner-passphrase' });
  let starts = 0;
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: 'http://localhost:3000', secureCookies: false,
    submitRequest: async () => ({ state: 'held' }),
    readRequest: () => null,
    titleRegistry: { isKnownTitle: ({ anidbId }) => anidbId === 42 },
    startTitleCheck: () => ({ state: starts++ ? 'shared' : 'queued',
      generation: 1 }),
    getTitleCheck: () => ({ state: 'checking', generation: 1,
      totalCount: 12, checkedCount: 3, recentAvailableCount: 2 }),
  });
  try {
    const url = '/api/catalogue/42/title-check';
    assert.equal((await app.inject({ method: 'POST', url,
      payload: {} })).statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: 'http://localhost:3000' },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin: 'http://localhost:3000',
      'x-negev-csrf': session.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url,
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {} })).statusCode, 403);
    assert.deepEqual((await app.inject({ method: 'POST', url,
      headers, payload: {} })).json(),
    { state: 'queued', generation: 1 });
    assert.deepEqual((await app.inject({ method: 'POST', url,
      headers, payload: {} })).json(),
    { state: 'shared', generation: 1 });
    assert.deepEqual((await app.inject({ method: 'GET', url,
      headers: { cookie } })).json(),
    { state: 'checking', generation: 1, totalCount: 12,
      checkedCount: 3, recentAvailableCount: 2 });
    assert.equal(starts, 2);
    assert.equal((await app.inject({ method: 'POST', url,
      headers, payload: { episodeIds: [1] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST',
      url: '/api/catalogue/99/title-check', headers,
      payload: {} })).statusCode, 404);
  } finally {
    await app.close(); accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
});
