import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

test('only the admin can probe saved targets; response contains no provider file details', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-presence-route-'));
  const accounts = openAccountLedger(path.join(dir, 'accounts.sqlite'),
    { now: () => 1_000 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner',
    password: 'long-owner-passphrase' });
  const invite = accounts.createInvite({ adminUserId: owner.id,
    expiresMs: 10_000 });
  await accounts.registerInvite({ code: invite.code, username: 'Friend',
    password: 'long-member-passphrase' });
  const calls = [];
  let activityReads = 0;
  const origin = 'http://localhost:3000';
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => ({ state: 'held', reason: 'disabled' }),
    readRequest: (id) => id === 1 ? { id: 1, anidbId: 42,
      kind: 'series', episodeIds: [1001, 1002] } : null,
    probeRequestTargets: async ({ request, episodeIds }) => {
      calls.push({ id: request.id, episodeIds });
      return { state: 'probe', observedAtMs: 500,
        targets: episodeIds.map((episodeId) => ({ episodeId,
          state: 'unknown', reason: 'locally_missing_unconfirmed',
          privatePath: '/secret/media.mkv' })) };
    },
    readImportActivity: async () => {
      activityReads++;
      return { state: 'quiet_observed', privatePath: '/secret/Import' };
    },
  });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner',
        password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const friendLogin = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Friend',
        password: 'long-member-passphrase' } });
    const friendCookie = friendLogin.headers['set-cookie'].split(';')[0];
    const friendSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: friendCookie } });
    const headers = { cookie, origin,
      'x-negev-csrf': session.json().csrfToken };
    const request = { method: 'POST',
      url: '/api/requests/1/presence-probe', headers,
      payload: { episodeIds: [1002] } };
    assert.equal((await app.inject({ ...request, headers: {
      cookie: friendCookie, origin,
      'x-negev-csrf': friendSession.json().csrfToken } })).statusCode, 403);
    const result = await app.inject(request);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { state: 'probe', observedAtMs: 500,
      targets: [{ episodeId: 1002, state: 'unknown',
        reason: 'locally_missing_unconfirmed' }] });
    assert.deepEqual(calls, [{ id: 1, episodeIds: [1002] }]);
    const diagnostic = { method: 'POST', url: '/api/admin/import-activity',
      headers, payload: {} };
    assert.equal((await app.inject({ ...diagnostic, headers: {
      cookie: friendCookie, origin,
      'x-negev-csrf': friendSession.json().csrfToken } })).statusCode, 403);
    assert.equal(activityReads, 0);
    const activity = await app.inject(diagnostic);
    assert.equal(activity.statusCode, 200, activity.body);
    assert.deepEqual(activity.json(), { state: 'import_activity',
      activity: 'quiet_observed', acquisitionAuthorized: false });
    assert.equal(activityReads, 1);
  } finally {
    await app.close(); accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
});
