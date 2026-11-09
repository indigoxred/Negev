import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
const owner = { id: 7, username: 'Owner', role: 'admin',
  sessionVersion: 1, adultAllowed: true };
const accounts = (user = owner) => ({
  authenticate: async () => user,
  getSessionUser: ({ userId, version }) => userId === user.id &&
    version === user.sessionVersion ? user : null,
  registerInvite: async () => null, createInvite: () => null,
  revokeSessions: () => false,
});

async function signedIn(app) {
  const login = await app.inject({ method: 'POST', url: '/api/login',
    headers: { origin }, payload: { username: 'Owner',
      password: 'long-owner-passphrase' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const session = await app.inject({ method: 'GET', url: '/api/session',
    headers: { cookie } });
  return { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
}

test('cold installment saves a preparation without client-supplied title or target',
  async () => {
    const calls = [];
    const app = await buildUserApp({ accounts: accounts(),
      sessionKey: randomBytes(32), publicOrigin: origin,
      secureCookies: false, readRequest: () => null,
      confirmKnownTitle: async () => true,
      submitRequest: async () => ({ state: 'held', reason: 'detail_pending' }),
      queuePendingTitle: (input) => { calls.push(input); return {
        state: 'pending', intentId: 12, created: true }; },
    });
    try {
      const headers = await signedIn(app);
      const body = { anidbId: 4158, scope: 'installment',
        requestKey: 'cold-one' };
      const forbidden = await app.inject({ method: 'POST',
        url: '/api/requests', headers: { cookie: headers.cookie, origin },
        payload: body });
      assert.equal(forbidden.statusCode, 403);
      const saved = await app.inject({ method: 'POST', url: '/api/requests',
        headers, payload: body });
      assert.equal(saved.statusCode, 202, saved.body);
      assert.deepEqual(saved.json(), { state: 'pending', intentId: 12,
        created: true });
      assert.deepEqual(calls, [{ requesterId: 7,
        anidbId: 4158, requestKey: 'cold-one' }]);
      const selected = await app.inject({ method: 'POST', url: '/api/requests',
        headers, payload: { ...body, scope: 'episodes', episodeIds: [88],
          requestKey: 'selected' } });
      assert.equal(selected.statusCode, 409);
      assert.equal(calls.length, 1);
    } finally { await app.close(); }
  });

test('an installment with no trustworthy release date saves a pending watch', async () => {
  const app = await buildUserApp({ accounts: accounts(),
    sessionKey: randomBytes(32), publicOrigin: origin,
    secureCookies: false, readRequest: () => null,
    confirmKnownTitle: async () => true,
    submitRequest: async () => ({ state: 'held', reason: 'release_state_unknown' }),
    queuePendingTitle: () => ({ state: 'pending', intentId: 14, created: true }),
  });
  try {
    const headers = await signedIn(app);
    const saved = await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 4158, scope: 'installment',
        requestKey: 'unknown-date' } });
    assert.equal(saved.statusCode, 202, saved.body);
    assert.equal(saved.json().state, 'pending');
    assert.equal(saved.json().waitingFor, 'release_schedule');
  } finally { await app.close(); }
});

test('a restricted account cannot save an unknown-age pending title',
  async () => {
    let queued = 0;
    const app = await buildUserApp({ accounts: accounts({ ...owner,
      adultAllowed: false }), sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false, readRequest: () => null,
      confirmKnownTitle: async () => true,
      loadDetail: async ({ anidbId }) => ({ state: 'detail_pending', anidbId }),
      submitRequest: async () => ({ state: 'held', reason: 'detail_pending' }),
      queuePendingTitle: () => { queued++; return { state: 'pending' }; },
    });
    try {
      const headers = await signedIn(app);
      const response = await app.inject({ method: 'POST',
        url: '/api/requests', headers, payload: { anidbId: 4158,
          scope: 'installment', requestKey: 'restricted' } });
      assert.equal(response.statusCode, 403);
      assert.equal(queued, 0);
    } finally { await app.close(); }
  });

test('a fresh key cannot duplicate an active pending title', async () => {
  let submissions = 0;
  const app = await buildUserApp({ accounts: accounts(),
    sessionKey: randomBytes(32), publicOrigin: origin,
    secureCookies: false, readRequest: () => null,
    confirmKnownTitle: async () => true,
    submitRequest: async () => { submissions++;
      return { state: 'held', requestId: 99 }; },
    readActivePendingTitle: () => ({ id: 12, requesterId: 7,
      anidbId: 4158, state: 'pending' }),
  });
  try {
    const headers = await signedIn(app);
    const response = await app.inject({ method: 'POST',
      url: '/api/requests', headers, payload: { anidbId: 4158,
        scope: 'installment', requestKey: 'another-key' } });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().intentId, 12);
    assert.equal(submissions, 0);
  } finally { await app.close(); }
});

test('a pending key is checked before exact submitter can claim it for another title',
  async () => {
    let submissions = 0;
    const app = await buildUserApp({ accounts: accounts(),
      sessionKey: randomBytes(32), publicOrigin: origin,
      secureCookies: false, readRequest: () => null,
      confirmKnownTitle: async () => true,
      submitRequest: async () => { submissions++;
        return { state: 'held', requestId: 77 }; },
      readPendingTitleByKey: () => ({ id: 12, requesterId: 7,
        anidbId: 4158, state: 'pending' }),
    });
    try {
      const headers = await signedIn(app);
      const same = await app.inject({ method: 'POST', url: '/api/requests',
        headers, payload: { anidbId: 4158, scope: 'installment',
          requestKey: 'cold-one' } });
      assert.equal(same.statusCode, 202, same.body);
      assert.equal(same.json().intentId, 12);
      const conflict = await app.inject({ method: 'POST', url: '/api/requests',
        headers, payload: { anidbId: 4159, scope: 'installment',
          requestKey: 'cold-one' } });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.json().reason, 'idempotency_key_conflict');
      const otherScope = await app.inject({ method: 'POST', url: '/api/requests',
        headers, payload: { anidbId: 4158, scope: 'episodes',
          episodeIds: [88], requestKey: 'cold-one' } });
      assert.equal(otherScope.statusCode, 409, otherScope.body);
      assert.equal(otherScope.json().reason, 'idempotency_key_conflict');
      assert.equal(submissions, 0);
    } finally { await app.close(); }
  });

test('pending history and cancellation are owner scoped and CSRF guarded',
  async () => {
    const calls = [];
    const app = await buildUserApp({ accounts: accounts(),
      sessionKey: randomBytes(32), publicOrigin: origin,
      secureCookies: false, readRequest: () => null,
      confirmKnownTitle: async () => true,
      submitRequest: async () => ({ state: 'held',
        reason: 'detail_pending' }),
      listPendingTitles: ({ requesterId }) => ({ items: [{ id: 12,
        requesterId, anidbId: 4158, title: 'Pale Cocoon',
        state: 'pending', reason: 'detail_pending' }], nextBeforeId: null }),
      readPendingTitle: (id) => ({ id,
        requesterId: id === 13 ? 8 : 7 }),
      cancelPendingTitle: (input) => { calls.push(input);
        return input.intentId === 14
          ? { state: 'held', reason: 'resolution_in_progress' }
          : { state: 'cancelled', intentId: input.intentId }; },
    });
    try {
      const anonymous = await app.inject({ method: 'GET',
        url: '/api/request-preparations' });
      assert.equal(anonymous.statusCode, 401);
      const headers = await signedIn(app);
      const listed = await app.inject({ method: 'GET',
        url: '/api/request-preparations', headers: { cookie: headers.cookie } });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.deepEqual(listed.json().items.map((row) => row.id), [12]);
      assert.equal((await app.inject({ method: 'POST',
        url: '/api/request-preparations/12/cancel',
        headers: { cookie: headers.cookie, origin },
        payload: {} })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST',
        url: '/api/request-preparations/13/cancel', headers,
        payload: {} })).statusCode, 404);
      const cancelled = await app.inject({ method: 'POST',
        url: '/api/request-preparations/12/cancel', headers, payload: {} });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(cancelled.json().state, 'cancelled');
      const resolving = await app.inject({ method: 'POST',
        url: '/api/request-preparations/14/cancel', headers, payload: {} });
      assert.equal(resolving.statusCode, 409);
      assert.match(resolving.json().error, /being finalized/);
      assert.deepEqual(calls.map((input) => [input.requesterId,
        input.intentId]), [[7, 12], [7, 14]]);
    } finally { await app.close(); }
  });
