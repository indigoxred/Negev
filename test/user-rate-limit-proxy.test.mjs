import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { buildUserApp } from '../src/web/user-app.mjs';

test('signed-in users sharing one proxy each get their own search budget', async () => {
  const origin = 'http://localhost:3000';
  const users = new Map([
    ['Owner', { id: 1, username: 'Owner', role: 'admin', sessionVersion: 1 }],
    ['Friend', { id: 2, username: 'Friend', role: 'member', sessionVersion: 1 }],
  ]);
  const accounts = {
    authenticate: async ({ username }) => users.get(username) ?? null,
    getSessionUser: ({ userId, version }) =>
      [...users.values()].find((user) => user.id === userId &&
        user.sessionVersion === version) ?? null,
    registerInvite: async () => null,
    createInvite: () => null,
    revokeSessions: () => false,
  };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    titleRegistry: { observe: () => true },
    searchTitles: async () => ({ state: 'results', total: 0, items: [] }),
  });
  try {
    const login = async (username) => {
      const response = await app.inject({ method: 'POST', url: '/api/login',
        headers: { origin }, payload: { username, password: 'test-passphrase' } });
      assert.equal(response.statusCode, 200);
      return response.headers['set-cookie'].split(';')[0];
    };
    const ownerCookie = await login('Owner');
    const friendCookie = await login('Friend');
    const search = (cookie, forwardedFor) => app.inject({ method: 'GET',
      url: '/api/catalogue/search?q=anime', headers: {
        cookie, 'x-forwarded-for': forwardedFor },
    });

    for (let i = 0; i < 20; i++) {
      assert.equal((await search(ownerCookie, `203.0.113.${i + 1}`)).statusCode, 200);
    }
    assert.equal((await search(ownerCookie, '203.0.113.250')).statusCode, 429);
    for (let i = 0; i < 20; i++) {
      assert.equal((await search(friendCookie, '198.51.100.10')).statusCode, 200);
    }
    assert.equal((await search(friendCookie, '198.51.100.11')).statusCode, 429);
  } finally { await app.close(); }
});

test('login attempts still share the proxy budget after one account signs in', async () => {
  const origin = 'http://localhost:3000';
  const user = { id: 1, username: 'Owner', role: 'admin', sessionVersion: 1 };
  const app = await buildUserApp({
    accounts: {
      authenticate: async () => user,
      getSessionUser: () => user,
      registerInvite: async () => null,
      createInvite: () => null,
      revokeSessions: () => false,
    },
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
  });
  try {
    const attempt = (cookie, forwardedFor) => app.inject({ method: 'POST',
      url: '/api/login', headers: { origin,
        ...(cookie ? { cookie } : {}), 'x-forwarded-for': forwardedFor },
      payload: { username: 'Owner', password: 'test-passphrase' },
    });
    const first = await attempt(null, '203.0.113.1');
    assert.equal(first.statusCode, 200);
    const cookie = first.headers['set-cookie'].split(';')[0];
    for (let i = 0; i < 4; i++) {
      assert.equal((await attempt(cookie, `203.0.113.${i + 2}`)).statusCode, 200);
    }
    assert.equal((await attempt(cookie, '203.0.113.250')).statusCode, 429);
  } finally { await app.close(); }
});

test('normal title browsing can open more than ten detail pages per minute', async () => {
  const origin = 'http://localhost:3000';
  const user = { id: 1, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const app = await buildUserApp({
    accounts: { authenticate: async () => user, getSessionUser: () => user,
      registerInvite: async () => null, createInvite: () => null,
      revokeSessions: () => false },
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    loadDetail: async ({ anidbId, page }) => ({ state: 'details', anidbId,
      page, kind: 'series', restricted: false, episodes: [], total: 0 }),
  });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin },
      payload: { username: 'Owner', password: 'test-passphrase' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    for (let id = 1; id <= 12; id++) {
      const result = await app.inject({ method: 'GET',
        url: `/api/catalogue/${id}`, headers: { cookie } });
      assert.equal(result.statusCode, 200, `title ${id}: ${result.body}`);
    }
  } finally { await app.close(); }
});

test('related title browsing can expand more than five links per minute', async () => {
  const origin = 'http://localhost:3000';
  const user = { id: 1, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const app = await buildUserApp({
    accounts: { authenticate: async () => user, getSessionUser: () => user,
      registerInvite: async () => null, createInvite: () => null,
      revokeSessions: () => false },
    sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    titleRegistry: { observe: () => true },
    confirmKnownTitle: async () => true,
    loadRelatedTitles: async ({ anidbId }) => ({ state: 'related_titles',
      anidbId, completeness: 'unproven', items: [] }),
  });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin },
      payload: { username: 'Owner', password: 'test-passphrase' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    for (let id = 1; id <= 6; id++) {
      const result = await app.inject({ method: 'GET',
        url: `/api/catalogue/${id}/related`, headers: { cookie } });
      assert.equal(result.statusCode, 200, `related ${id}: ${result.body}`);
    }
  } finally { await app.close(); }
});
