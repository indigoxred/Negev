import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';

test('invited users have private request ownership and CSRF guarded sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-app-'));
  const accounts = openAccountLedger(path.join(dir, 'accounts.sqlite'), { now: () => 1_000 });
  const requestLedger = openRequestLedger(path.join(dir, 'requests.sqlite'));
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  const observed = [];
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32), publicOrigin: origin,
    secureCookies: false, now: () => 1_000,
    submitRequest: async (command) => requestLedger.submit({
      requesterId: command.requesterId, requestKey: command.requestKey, nowMs: 1_000,
      intent: { state: 'ready', anidbId: 1234, kind: 'series',
        episodeIds: [1001], monitorFuture: true },
    }),
    readRequest: (id) => requestLedger.getRequest(id),
    listRequests: (input) => requestLedger.listRequests(input),
    titleRegistry: { isKnownTitle: ({ anidbId }) => anidbId === 1234 },
    loadRelatedTitles: async ({ anidbId }) => ({ state: 'related_titles',
      anidbId, completeness: 'unproven', items: [{ anidbId: 5678,
        title: 'Another installment', relation: 'Sequel' }] }),
    observePublicTarget: async (target) => { observed.push(target);
      return { state: 'available', fileId: 900 }; },
  });
  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.body, /Negev/);
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /javascript/);
    const unauthorized = await app.inject({ method: 'GET', url: '/api/session' });
    assert.equal(unauthorized.statusCode, 401);
    const crossSite = await app.inject({ method: 'POST', url: '/api/login',
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(crossSite.statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers['set-cookie'].split(';')[0];
    assert.match(login.headers['set-cookie'], /HttpOnly/);
    assert.match(login.headers['set-cookie'], /SameSite=Strict/);
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    assert.equal(session.json().user.id, owner.id);
    const related = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/related', headers: { cookie } });
    assert.equal(related.statusCode, 200);
    assert.equal(related.json().completeness, 'unproven');
    assert.equal(related.json().items[0].anidbId, 5678);
    const unknownRelated = await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/related', headers: { cookie } });
    assert.equal(unknownRelated.statusCode, 404);
    const csrf = session.json().csrfToken;
    assert.match(csrf, /^[a-f0-9]{64}$/);
    const missingCsrf = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie, origin }, payload: { anidbId: 1234, scope: 'installment', requestKey: 'first' } });
    assert.equal(missingCsrf.statusCode, 403);
    const forged = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie, origin, 'x-negev-csrf': csrf },
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'first', requesterId: 999 } });
    assert.equal(forged.statusCode, 400);
    const submitted = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie, origin, 'x-negev-csrf': csrf },
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'first' } });
    assert.equal(submitted.statusCode, 202, submitted.body);
    assert.equal(requestLedger.getRequest(1).requesterId, owner.id);
    const available = await app.inject({ method: 'GET',
      url: '/api/requests/1/episodes/1001/availability', headers: { cookie } });
    assert.equal(available.statusCode, 200);
    assert.deepEqual(available.json(), { state: 'available' });
    assert.deepEqual(observed, [{ anidbId: 1234, episodeId: 1001, kind: 'series' }]);
    const direct = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/episodes/1001/availability?kind=series',
      headers: { cookie } });
    assert.deepEqual(direct.json(), { state: 'available' });
    assert.deepEqual(observed.at(-1), { anidbId: 1234,
      episodeId: 1001, kind: 'series' });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/episodes/1001/availability?kind=series',
      headers: { cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/requests/1/episodes/1002/availability', headers: { cookie } })).statusCode, 404);
    const mine = await app.inject({ method: 'GET', url: '/api/requests',
      headers: { cookie } });
    assert.deepEqual(mine.json().items.map((item) => item.id), [1]);
    assert.equal((await app.inject({ method: 'GET', url: '/api/requests?limit=1000',
      headers: { cookie } })).statusCode, 400);
    const invited = await app.inject({ method: 'POST', url: '/api/invitations',
      headers: { cookie, origin, 'x-negev-csrf': csrf }, payload: {} });
    assert.equal(invited.statusCode, 201, invited.body);
    const register = await app.inject({ method: 'POST', url: '/api/register', headers: { origin },
      payload: { code: invited.json().code, username: 'Friend', password: 'long-member-passphrase' } });
    assert.equal(register.statusCode, 201, register.body);
    const friendLogin = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
      payload: { username: 'Friend', password: 'long-member-passphrase' } });
    assert.equal(friendLogin.statusCode, 200, friendLogin.body);
    const friendCookie = friendLogin.headers['set-cookie'].split(';')[0];
    const friendList = await app.inject({ method: 'GET', url: '/api/requests',
      headers: { cookie: friendCookie } });
    assert.deepEqual(friendList.json().items, []);
    const friendSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: friendCookie } });
    const memberInvite = await app.inject({ method: 'POST', url: '/api/invitations',
      headers: { cookie: friendCookie, origin,
        'x-negev-csrf': friendSession.json().csrfToken }, payload: {} });
    assert.equal(memberInvite.statusCode, 403);
    const hidden = await app.inject({ method: 'GET', url: '/api/requests/1',
      headers: { cookie: friendCookie } });
    assert.equal(hidden.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/requests/1/episodes/1001/availability',
      headers: { cookie: friendCookie } })).statusCode, 404);
    const wrongOrigin = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie, origin: 'https://attacker.example', 'x-negev-csrf': csrf },
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'second' } });
    assert.equal(wrongOrigin.statusCode, 403);
    let throttled = false;
    const guessStatuses = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const guess = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
        payload: { username: 'Owner', password: 'incorrect-passphrase' } });
      if (guess.statusCode === 429) throttled = true;
      guessStatuses.push(guess.statusCode);
    }
    assert.equal(throttled, true, guessStatuses.join(','));
    const logout = await app.inject({ method: 'POST', url: '/api/logout',
      headers: { cookie, origin, 'x-negev-csrf': csrf }, payload: {} });
    assert.equal(logout.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } })).statusCode, 401);
  } finally {
    await app.close();
    accounts.close();
    requestLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
