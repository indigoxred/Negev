import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
const items = [
  { anidbId: 1, title: 'Known all-ages', adult: false },
  { anidbId: 2, title: 'Known restricted', adult: true },
  { anidbId: 3, title: 'Not yet classified' },
];

async function searchAs(adultAllowed) {
  const user = { id: 7, username: 'Viewer', role: 'member', sessionVersion: 1, adultAllowed };
  const accounts = { authenticate: async () => user, getSessionUser: () => user,
    registerInvite: async () => null, createInvite: () => null, revokeSessions: () => false };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    titleRegistry: { observe: () => true, isKnownTitle: () => true },
    searchTitles: async () => ({ state: 'results', total: items.length, page: 1,
      items: items.map((item) => ({ ...item })) }) });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Viewer', password: 'long-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const response = await app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=test', headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().items.map((item) => item.anidbId);
  } finally { await app.close(); }
}

test('search hides known 18+ titles from accounts without 18+ access', async () => {
  assert.deepEqual(await searchAs(false), [1, 3]);
});

test('search keeps 18+ titles for accounts with 18+ access', async () => {
  assert.deepEqual(await searchAs(true), [1, 2, 3]);
});
