import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';

test('one season batch applies the normal request gate to every selected installment', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const submitted = [];
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    acquisitionAllowedAnidbIds: [41, 42],
    submitRequest: async (input) => {
      submitted.push(input);
      return { state: 'held', requestId: input.anidbId,
        reason: 'test_request' };
    }, readRequest: () => null });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    const payload = { seasons: [
      { anidbId: 41, requestKey: 'season41' },
      { anidbId: 43, requestKey: 'season43' },
      { anidbId: 42, requestKey: 'season42' },
    ] };
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests/seasons',
      headers: { cookie, origin }, payload })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url: '/api/requests/seasons',
      headers, payload });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().items.map(({ anidbId, status }) =>
      [anidbId, status]), [[41, 202], [43, 409], [42, 202]]);
    assert.deepEqual(submitted.map(({ anidbId }) => anidbId), [41, 42]);
    const duplicate = await app.inject({ method: 'POST', url: '/api/requests/seasons',
      headers, payload: { seasons: [payload.seasons[0], payload.seasons[0]] } });
    assert.equal(duplicate.statusCode, 400);
  } finally { await app.close(); }
});

test('a limited acquisition cohort rejects other new titles before saving a request', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const submitted = [];
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    acquisitionAllowedAnidbIds: [1234],
    loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId,
      kind: 'series', restricted: false, episodes: [], nextPage: null }),
    submitRequest: async (input) => { submitted.push(input); return {
      state: 'held', requestId: 1, reason: 'test_request' }; },
    readRequest: () => null });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    const openDetail = await app.inject({ method: 'GET', url: '/api/catalogue/1234',
      headers: { cookie } });
    const closedDetail = await app.inject({ method: 'GET', url: '/api/catalogue/1235',
      headers: { cookie } });
    assert.equal(openDetail.json().requestsOpen, true);
    assert.equal(closedDetail.json().requestsOpen, false);
    const blocked = await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 1235, scope: 'installment', requestKey: 'outside' } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().reason, 'title_not_in_cutover');
    assert.match(blocked.json().error, /not open yet/i);
    assert.equal(submitted.length, 0);
    const invalid = await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: '1235', scope: 'installment', requestKey: 'invalid' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(submitted.length, 0);
    const allowed = await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 1234, scope: 'installment', requestKey: 'inside' } });
    assert.equal(allowed.statusCode, 202);
    assert.equal(submitted.length, 1);
  } finally { await app.close(); }
});

test('Sonarr ownership closes monitored titles and fails closed on an API outage', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const submitted = [];
  let unavailable = false;
  const ownershipGate = {
    status: (id) => unavailable ? 'unavailable' :
      id === 41 ? 'owned' : id === 42 ? 'eligible' : 'unmapped',
    refresh: async () => unavailable
      ? { state: 'held', reason: 'sonarr_ownership_unavailable' }
      : { state: 'ready' },
  };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    ownershipGate,
    loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId,
      kind: 'series', restricted: false, episodes: [], nextPage: null }),
    submitRequest: async (input) => {
      submitted.push(input);
      return { state: 'held', requestId: 2, reason: 'test_request' };
    }, readRequest: () => null });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalogue/41',
      headers: { cookie } })).json().requestsOpen, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalogue/42',
      headers: { cookie } })).json().requestsOpen, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 41, scope: 'installment', requestKey: 'owned' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 43, scope: 'installment', requestKey: 'unknown' } })).statusCode, 409);
    unavailable = true;
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 42, scope: 'installment', requestKey: 'outage' } })).statusCode, 503);
    unavailable = false;
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests',
      headers, payload: { anidbId: 42, scope: 'installment', requestKey: 'open' } })).statusCode, 202);
    assert.equal(submitted.length, 1);
  } finally { await app.close(); }
});

test('signed-in Airing preferences are owner scoped and require CSRF to change', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  let preference = { mode: 'library', trackedAnidbIds: [] };
  const observedModes = [];
  const observedScheduleModes = [];
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false,
    getAiringPreferences: ({ userId }) => userId === 7 ? preference : null,
    setAiringPreferences: ({ userId, mode, trackedAnidbIds }) => {
      assert.equal(userId, 7);
      preference = { mode, trackedAnidbIds };
      return preference;
    } };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    confirmKnownTitle: async ({ anidbId }) => anidbId === 19,
    listSeasonalTitles: async (input) => {
      observedModes.push(input.airingPreference);
      return { state: 'ready', year: 0, season: 'ALL',
        sourceDate: '2026-11-09', items: [], availableTags: [],
        total: 0, nextAfter: null };
    },
    listAiringSchedule: ({ airingPreference }) => {
      observedScheduleModes.push(airingPreference);
      return { state: 'ready', week: '2026-W45', checkedMs: 1,
        items: [] };
    } });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const read = await app.inject({ method: 'GET', url: '/api/airing/preferences',
      headers: { cookie } });
    assert.deepEqual(read.json(), preference);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/airing/preferences',
      headers: { cookie, origin }, payload: { mode: 'custom', trackedAnidbIds: [19] } })).statusCode, 403);
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/airing/preferences',
      headers, payload: { mode: 'custom', trackedAnidbIds: [20] } })).statusCode, 404);
    const saved = await app.inject({ method: 'PUT', url: '/api/airing/preferences',
      headers, payload: { mode: 'custom', trackedAnidbIds: [19] } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json(), { mode: 'custom', trackedAnidbIds: [19] });
    const airing = await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing', headers: { cookie } });
    assert.equal(airing.statusCode, 200, airing.body);
    assert.deepEqual(observedModes, [{ mode: 'custom', trackedAnidbIds: [19] }]);
    const schedule = await app.inject({ method: 'GET', url: '/api/airing',
      headers: { cookie } });
    assert.equal(schedule.statusCode, 200, schedule.body);
    assert.deepEqual(observedScheduleModes,
      [{ mode: 'custom', trackedAnidbIds: [19] }]);
  } finally { await app.close(); }
});

test('rapid signed-in title browsing retains a bounded detail read budget', async () => {
  const user = { id: 17, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    loadDetail: async ({ anidbId, page }) => ({ state: 'details', anidbId,
      page, title: 'A title', kind: 'series', restricted: false,
      episodes: [], total: 0, nextPage: null, complete: true }),
    readDisplayMetadata: async ({ anidbId }) => ({ state: 'display', anidbId,
      title: 'A title', restricted: false, englishTitle: null,
      type: 'TV Series', startYear: 2026, startDate: null, endDate: null,
      episodeCount: 12, description: 'A series.', tags: [] }),
    confirmKnownTitle: async () => true });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    for (let id = 1; id <= 60; id++) {
      const response = await app.inject({ method: 'GET',
        url: `/api/catalogue/${id}`, headers: { cookie } });
      assert.equal(response.statusCode, 200, `title ${id}: ${response.body}`);
    }
    const excessive = await app.inject({ method: 'GET',
      url: '/api/catalogue/61', headers: { cookie } });
    assert.equal(excessive.statusCode, 429);
    for (let id = 1; id <= 20; id++) {
      const response = await app.inject({ method: 'GET',
        url: `/api/catalogue/${id}/display`, headers: { cookie } });
      assert.equal(response.statusCode, 200, `display ${id}: ${response.body}`);
    }
  } finally { await app.close(); }
});

test('cold-title preparation permits normal browsing after thirty deferred checks', async () => {
  const user = { id: 17, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const admitted = [];
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null,
    confirmKnownTitle: async () => true,
    hydrateTitle: async ({ anidbId }) => {
      admitted.push(anidbId);
      return { state: 'pending', reason: 'global_cooldown' };
    } });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    for (let id = 1; id <= 35; id++) {
      const response = await app.inject({ method: 'POST',
        url: `/api/catalogue/${id}/load-detail`, headers, payload: {} });
      assert.equal(response.statusCode, 202, response.body);
    }
    assert.deepEqual(admitted, Array.from({ length: 35 }, (_, index) => index + 1));
  } finally { await app.close(); }
});

test('request cancellation is owner scoped and CSRF protected', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const calls = [];
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: (id) => id === 2
      ? { id: 2, requesterId: 8 } : { id, requesterId: 7 },
    cancelRequest: (input) => { calls.push(input); return { state: 'cancelled', requestId: input.requestId }; } });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests/1/cancel',
      headers: { cookie, origin }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/requests/2/cancel',
      headers, payload: {} })).statusCode, 404);
    const cancelled = await app.inject({ method: 'POST', url: '/api/requests/1/cancel',
      headers, payload: {} });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(calls, [{ requesterId: 7, requestId: 1, nowMs: expectTime(calls[0]?.nowMs) }]);
  } finally { await app.close(); }
});

test('started release processing reports the real cancellation limit', async () => {
  const user = { id: 7, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = { authenticate: async () => user,
    getSessionUser: () => user, registerInvite: async () => null,
    createInvite: () => null, revokeSessions: () => false };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null,
    readRequest: () => ({ id: 1, requesterId: 7 }),
    cancelRequest: () => ({ state: 'held', reason: 'acquisition_started' }) });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const result = await app.inject({ method: 'POST', url: '/api/requests/1/cancel',
      headers: { cookie, origin, 'x-negev-csrf': session.json().csrfToken }, payload: {} });
    assert.equal(result.statusCode, 409);
    assert.match(result.json().error, /even if the download has not begun/i);
  } finally { await app.close(); }
});

function expectTime(value) { assert.ok(Number.isSafeInteger(value) && value >= 0); return value; }

test('a loopback tunnel uses the HTTPS origin and a Secure host-only session', async () => {
  const publicOrigin = 'https://negev.example.test';
  const accounts = {
    authenticate: async () => ({ id: 1, username: 'Owner', role: 'admin',
      sessionVersion: 1, adultAllowed: true }),
    registerInvite: async () => null, getSessionUser: () => null,
    createInvite: () => null, revokeSessions: () => false,
  };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin, secureCookies: true,
    submitRequest: async () => null, readRequest: () => null });
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: 'http://localhost:3000' },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(denied.statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: publicOrigin },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(login.statusCode, 200);
    assert.match(login.headers['set-cookie'], /^__Host-negev=/);
    assert.match(login.headers['set-cookie'], /; Secure(?:;|$)/i);
    assert.match(login.headers['set-cookie'], /; HttpOnly(?:;|$)/i);
  } finally { await app.close(); }
});

test('an exposed review instance keeps HTTPS and LAN HTTP sessions separate', async () => {
  const publicOrigin = 'https://anime.negev.red';
  const localOrigin = 'http://192.168.50.138:17116';
  const user = { id: 1, username: 'Owner', role: 'admin',
    sessionVersion: 1, adultAllowed: true };
  const accounts = {
    authenticate: async () => user, registerInvite: async () => null,
    getSessionUser: ({ userId, version }) => userId === 1 && version === 1
      ? user : null,
    createInvite: () => null, revokeSessions: () => false,
  };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin, localOrigin, secureCookies: true,
    submitRequest: async () => null, readRequest: () => null });
  try {
    const login = (site) => app.inject({ method: 'POST', url: '/api/login',
      headers: { origin: site, host: new URL(site).host },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const publicLogin = await login(publicOrigin);
    assert.equal(publicLogin.statusCode, 200);
    assert.match(publicLogin.headers['set-cookie'], /^__Host-negev=/);
    assert.match(publicLogin.headers['set-cookie'], /; Secure(?:;|$)/i);
    const localLogin = await login(localOrigin);
    assert.equal(localLogin.statusCode, 200);
    assert.match(localLogin.headers['set-cookie'], /^negev-lan-session=/);
    assert.doesNotMatch(localLogin.headers['set-cookie'], /; Secure(?:;|$)/i);
    for (const [site, response] of [[publicOrigin, publicLogin],
      [localOrigin, localLogin]]) {
      const session = await app.inject({ method: 'GET', url: '/api/session',
        headers: { host: new URL(site).host,
          cookie: response.headers['set-cookie'] } });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().user.username, 'Owner');
    }
    const cross = await app.inject({ method: 'POST', url: '/api/logout',
      headers: { host: new URL(localOrigin).host, origin: publicOrigin,
        cookie: localLogin.headers['set-cookie'] } });
    assert.equal(cross.statusCode, 401);
  } finally { await app.close(); }
});

test('busy password verification is retryable for sign-in and invited registration', async () => {
  const accounts = {
    authenticate: async () => ({ state: 'busy' }),
    registerInvite: async () => ({ state: 'held', reason: 'authentication_busy' }),
    getSessionUser: () => null,
    createInvite: () => null,
    revokeSessions: () => false,
  };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(login.statusCode, 503);
    assert.equal(login.headers['retry-after'], '1');
    const register = await app.inject({ method: 'POST', url: '/api/register',
      headers: { origin }, payload: { code: 'a'.repeat(64),
        username: 'Friend', password: 'long-member-passphrase' } });
    assert.equal(register.statusCode, 503);
    assert.equal(register.headers['retry-after'], '1');
  } finally { await app.close(); }
});

test('invited users have private request ownership and CSRF guarded sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-user-app-'));
  const accounts = openAccountLedger(path.join(dir, 'accounts.sqlite'), { now: () => 1_000 });
  const requestLedger = openRequestLedger(path.join(dir, 'requests.sqlite'));
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  const observed = [];
  const discovered = [];
  const previewed = [];
  const seasonalInputs = [];
  let seasonalTags = ['action', 'fantasy'];
  let acquisitionState = 'disabled';
  const knownTitles = new Set([1234, 1235]);
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32), publicOrigin: origin,
    secureCookies: false, now: () => 1_000,
    getAcquisitionStatus: () => ({ state: acquisitionState }),
    readImportActivity: async () => ({ state: 'busy',
      reason: 'unrecognized_import_video' }),
    submitRequest: async (command) => requestLedger.submit({
      requesterId: command.requesterId, requestKey: command.requestKey, nowMs: 1_000,
      intent: { state: 'ready', anidbId: 1234, kind: 'series',
        episodeIds: [1001], monitorFuture: true },
    }),
    readRequest: (id) => requestLedger.getRequest(id),
    listRequests: (input) => requestLedger.listRequests(input),
    listLibraryTitles: () => ({ state: 'current_proofs', items: [
      { anidbId: 1234, title: 'Example series',
        verifiedEpisodeCount: 2, lastVerifiedMs: 950 }],
    nextAfterAnidbId: null }),
    listAiringSchedule: async () => ({ state: 'ready', week: '2026-W45',
      checkedMs: 950, items: [{ anidbId: 1234, title: 'Example series',
        scheduledDate: '2026-11-02', episodeNumber: '3', adult: false,
        libraryPresence: { state: 'unknown', verifiedEpisodeCount: 0 } }] }),
    listSeasonalTitles: async ({ year, season, after, limit, kind, tag, status, sort }) => {
      seasonalInputs.push({ year, season, after, limit, kind, tag, status, sort });
      return { state: 'ready', year, season, sourceDate: '2026-11-05',
        availableTags: seasonalTags, total: 1,
        items: [{ anidbId: 1234, title: 'Example series',
          type: 'TV Series', releaseStatus: 'RELEASING', adult: false,
          rating: { score: 8.2, votes: 100, members: 500, checkedMs: 950 },
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 } }],
        nextAfter: null,
        requestedPage: { after, limit } };
    },
    readPoster: async ({ uid }) => uid === '123e4567-e89b-42d3-a456-426614174000'
      ? { state: 'image', type: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) }
      : { state: 'unavailable' },
    readCataloguePoster: async ({ anidbId }) => anidbId === 1234
      ? { state: 'image', type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) }
      : { state: 'unavailable' },
    readDisplayMetadata: async ({ anidbId }) => anidbId === 1235
      ? { state: 'display', anidbId, title: 'Adult series', restricted: true,
        englishTitle: null, type: 'TV Series', startYear: 2026,
        startDate: null, endDate: null, episodeCount: null,
        description: 'Private adult description.', tags: [] }
      : anidbId === 1234
      ? { state: 'display', anidbId, title: 'Example series',
        restricted: false, englishTitle: null, type: 'TV Series', startYear: 2026,
        startDate: null, endDate: null, episodeCount: null,
        season: 'Fall 2026', releaseStatus: 'Airing',
        studio: 'studio comet', durationMinutes: 23,
        description: 'A story about a test.', tags: ['Adventure'] }
      : { state: 'unavailable' },
    listOperationalReview: () => ({ state: 'review', items: [{
      attemptId: 9, requestId: 1, anidbId: 1234,
      stage: 'release_rejected', reason: 'file_wrong_identity', observedMs: 900,
    }, {
      attemptId: 10, requestId: 2, anidbId: 1235,
      stage: 'start_hold', reason: 'provider_unavailable', observedMs: 901,
    }, {
      attemptId: 11, requestId: 3, anidbId: 1236,
      stage: 'completion_interrupted', reason: 'completion_interrupted',
      observedMs: 902,
    }], nextAfterAttemptId: null }),
    titleRegistry: {
      isKnownTitle: ({ anidbId }) => knownTitles.has(anidbId),
      observe: (result) => {
        if (result?.state !== 'results' || !Array.isArray(result.items)) return false;
        for (const item of result.items) knownTitles.add(item.anidbId);
        return true;
      },
    },
    // A validated catalogue ID survives the in-memory search window.
    confirmKnownTitle: async ({ anidbId }) =>
      knownTitles.has(anidbId) || anidbId === 1234,
    loadDetail: async ({ anidbId, page }) => ({ state: 'details',
      anidbId, page, kind: 'series', restricted: anidbId === 1235, episodes: [
        { id: 1001, number: 1, type: 'Episode', title: 'One' },
        { id: 1002, number: 2, type: 'Episode', title: 'Two' },
        { id: 1003, number: 3, type: 'Episode', title: 'Three' },
        { id: 1004, number: 4, type: 'Episode', title: 'Four' },
        { id: 1005, number: 5, type: 'Episode', title: 'Five' },
        { id: 1006, number: 6, type: 'Episode', title: 'Six' }],
      total: 6, nextPage: null }),
    loadRelatedTitles: async ({ anidbId }) => ({ state: 'related_titles',
      anidbId, completeness: 'unproven', items: [{ anidbId: 5678,
        title: 'Another installment', relation: 'Sequel' }] }),
    discoverCandidates: async ({ requestId }) => { discovered.push(requestId);
      return { state: 'candidates', requestId, anidbId: 1234,
        exhaustive: false, items: [{ guid: 'synthetic', indexerId: 7,
          title: 'Unverified release', size: 1000, evidence: 'unverified' }] }; },
    previewCandidate: async ({ requestId, candidate }) => { previewed.push(requestId);
      assert.equal(candidate.guid, 'synthetic');
      return { state: 'preflight', requestId, anidbId: 1234,
        torrentHash: 'a'.repeat(40), version: 'v1', totalBytes: 1000,
        episodeIds: [1001], files: [{ name: 'Show - 01.mkv',
          size: 1000, episodeIds: [1001] }], subtitles: [],
        filesToExclude: [], registeredInAniDb: false,
        downloadStarted: false }; },
    observePublicTarget: async (target) => { observed.push(target);
      return target.episodeId === 1002 ? { state: 'unknown' } :
        target.episodeId === 1003
          ? { state: 'available', presentation: 'alternate_card' } :
        { state: 'available', fileId: 900 }; },
  });
  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /img-src 'self'/);
    assert.match(page.body, /Negev/);
    assert.match(page.body, /Sign in to see acquisition status/);
    assert.match(page.body, /<script src="\/app\.js" type="module"><\/script>/);
    assert.match(page.body, /<form id="login-form" method="post" action="\/api\/login">/);
    assert.match(page.body, /<form id="register-form" method="post" action="\/api\/register" hidden>/);
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /javascript/);
    const current = await app.inject({ method: 'GET', url: '/api/client-revision' });
    assert.equal(current.statusCode, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    const { revision } = current.json();
    assert.match(revision, /^[0-9a-f]{64}$/);
    assert.match(page.body, new RegExp(`<meta name="negev-client-revision" content="${revision}">`));
    const keyModule = await app.inject({ method: 'GET', url: '/request-key.mjs' });
    assert.equal(keyModule.statusCode, 200);
    assert.match(keyModule.headers['content-type'], /javascript/);
    const pagerModule = await app.inject({ method: 'GET', url: '/episode-pages.mjs' });
    assert.equal(pagerModule.statusCode, 200);
    assert.match(pagerModule.headers['content-type'], /javascript/);
    const searchPager = await app.inject({ method: 'GET', url: '/search-pages.mjs' });
    assert.equal(searchPager.statusCode, 200);
    assert.match(searchPager.headers['content-type'], /javascript/);
    const progressModule = await app.inject({ method: 'GET', url: '/request-progress-text.mjs' });
    assert.equal(progressModule.statusCode, 200);
    assert.match(progressModule.headers['content-type'], /javascript/);
    const epochModule = await app.inject({ method: 'GET', url: '/response-epoch.mjs' });
    assert.equal(epochModule.statusCode, 200);
    assert.match(epochModule.headers['content-type'], /javascript/);
    const franchiseModule = await app.inject({ method: 'GET', url: '/franchise-explorer.mjs' });
    assert.equal(franchiseModule.statusCode, 200);
    assert.match(franchiseModule.headers['content-type'], /javascript/);
    for (const match of script.body.matchAll(/from '\.\/([^']+)'/g)) {
      const dependency = await app.inject({ method: 'GET', url: `/${match[1]}` });
      assert.equal(dependency.statusCode, 200, `Missing browser module ${match[1]}`);
      assert.match(dependency.headers['content-type'], /javascript/);
      assert.equal(dependency.body,
        await readFile(new URL(`../src/web/public/${match[1]}`, import.meta.url), 'utf8'),
        `Wrong browser module served at ${match[1]}`);
    }
    const unauthorized = await app.inject({ method: 'GET', url: '/api/session' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/library' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/airing' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/posters/123e4567-e89b-42d3-a456-426614174000' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/admin/review' })).statusCode, 401);
    const crossSite = await app.inject({ method: 'POST', url: '/api/login',
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(crossSite.statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
      payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const poster = await app.inject({ method: 'GET',
      url: '/api/catalogue/posters/123e4567-e89b-42d3-a456-426614174000',
      headers: { cookie } });
    assert.equal(poster.statusCode, 200);
    assert.match(poster.headers['content-type'], /image\/jpeg/);
    assert.deepEqual(poster.rawPayload, Buffer.from([1, 2, 3]));
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/posters/not-a-uuid', headers: { cookie } })).statusCode, 404);
    const cataloguePoster = await app.inject({ method: 'GET',
      url: '/api/catalogue/posters/anidb/1234', headers: { cookie } });
    assert.equal(cataloguePoster.statusCode, 200);
    assert.deepEqual(cataloguePoster.rawPayload, Buffer.from([0xff, 0xd8, 0xff]));
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/posters/anidb/9999', headers: { cookie } })).statusCode, 404);
    assert.match(login.headers['set-cookie'], /HttpOnly/);
    assert.match(login.headers['set-cookie'], /SameSite=Strict/);
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    assert.equal(session.json().user.id, owner.id);
    const library = await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } });
    assert.equal(library.statusCode, 200);
    assert.deepEqual(library.json(), { state: 'current_proofs', items: [
      { anidbId: 1234, title: 'Example series',
        verifiedEpisodeCount: 2, lastVerifiedMs: 950 }], nextAfterAnidbId: null });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/library?afterAnidbId=-1', headers: { cookie } })).statusCode, 400);
    const airing = await app.inject({ method: 'GET', url: '/api/airing', headers: { cookie } });
    assert.equal(airing.statusCode, 200);
    assert.deepEqual(airing.json(), { state: 'ready', week: '2026-W45',
      checkedMs: 950, items: [{ anidbId: 1234, title: 'Example series',
        scheduledDate: '2026-11-02', episodeNumber: '3', adult: false,
        libraryPresence: { state: 'unknown', verifiedEpisodeCount: 0 } }] });
    const seasonal = await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL', headers: { cookie } });
    assert.equal(seasonal.statusCode, 200);
    assert.deepEqual(seasonal.json(), { state: 'ready', year: 2026,
      season: 'FALL', sourceDate: '2026-11-05',
      availableTags: ['action', 'fantasy'], total: 1,
      items: [{ anidbId: 1234,
        title: 'Example series', type: 'TV Series',
        releaseStatus: 'RELEASING', adult: false,
        rating: { score: 8.2, votes: 100, members: 500, checkedMs: 950 },
        libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 } }],
      nextAfter: null });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL&admin=true',
      headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL&kind=movies&tag=action',
      headers: { cookie } })).statusCode, 200);
    assert.deepEqual(seasonalInputs.at(-1), { year: 2026, season: 'FALL',
      after: 0, limit: 18, kind: 'movies', tag: 'action', status: 'all',
      sort: 'newest' });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL&status=ongoing',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).status, 'ongoing');
    assert.equal(seasonalInputs.at(-1).limit, 12,
      'Airing keeps its existing bounded page size');
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing&sort=title_desc',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).sort, 'title_desc');
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing&sort=next_episode',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).sort, 'next_episode');
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing&sort=score_desc',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).sort, 'score_desc');
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing&sort=popular_desc',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).sort, 'popular_desc');
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL&status=ongoing&sort=popularity',
      headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL',
      headers: { cookie } })).statusCode, 200);
    assert.equal(seasonalInputs.at(-1).year, 0);
    seasonalTags = Array.from({ length: 2_464 }, (_, index) => `theme ${index}`);
    const fullCatalogue = await app.inject({ method: 'GET',
      url: '/api/seasons?year=0&season=ALL', headers: { cookie } });
    assert.equal(fullCatalogue.statusCode, 200);
    assert.equal(fullCatalogue.json().availableTags.length, 2_464);
    seasonalTags = ['action', 'fantasy'];
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/seasons?year=2026&season=FALL&tag=%0A',
      headers: { cookie } })).statusCode, 400);
    const review = await app.inject({ method: 'GET',
      url: '/api/admin/review', headers: { cookie } });
    assert.equal(review.statusCode, 200);
    assert.deepEqual(review.json().items, [{ attemptId: 9, requestId: 1,
      anidbId: 1234, stage: 'release_rejected',
      reason: 'file_wrong_identity', observedMs: 900 },
    { attemptId: 10, requestId: 2, anidbId: 1235,
      stage: 'start_hold', reason: 'provider_unavailable', observedMs: 901 },
    { attemptId: 11, requestId: 3, anidbId: 1236,
      stage: 'completion_interrupted', reason: 'completion_interrupted',
      observedMs: 902 }]);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/admin/review?limit=100', headers: { cookie } })).statusCode, 400);
    assert.deepEqual(session.json().capabilities, {
      releaseSearch: true, detailLoad: false, availabilityChecks: false,
      acquisitionState: 'disabled' });
    acquisitionState = 'waiting';
    const activeSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(activeSession.json().capabilities.acquisitionState, 'waiting');
    acquisitionState = 'waiting_with_review';
    const reviewSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(reviewSession.json().capabilities.acquisitionState,
      'waiting_with_review');
    acquisitionState = 'unexpected';
    const unknownSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(unknownSession.json().capabilities.acquisitionState,
      'unknown');
    acquisitionState = 'reconciliation_held';
    const heldSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(heldSession.json().capabilities.acquisitionState,
      'reconciliation_held');
    const related = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/related', headers: { cookie } });
    assert.equal(related.statusCode, 200);
    assert.equal(related.json().completeness, 'unproven');
    assert.equal(related.json().items[0].anidbId, 5678);
    assert.equal(knownTitles.has(5678), true);
    const unknownRelated = await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/related', headers: { cookie } });
    assert.equal(unknownRelated.statusCode, 404);
    const csrf = session.json().csrfToken;
    assert.match(csrf, /^[a-f0-9]{64}$/);
    const importActivity = await app.inject({ method: 'POST',
      url: '/api/admin/import-activity',
      headers: { cookie, origin, 'x-negev-csrf': csrf }, payload: {} });
    assert.deepEqual(importActivity.json(), { state: 'import_activity',
      activity: 'busy', reason: 'unrecognized_import_video',
      acquisitionAuthorized: false });
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
    const candidates = await app.inject({ method: 'GET',
      url: '/api/requests/1/candidates', headers: { cookie } });
    assert.equal(candidates.statusCode, 200);
    assert.equal(candidates.json().items[0].evidence, 'unverified');
    assert.deepEqual(discovered, [1]);
    const preflight = await app.inject({ method: 'POST',
      url: '/api/requests/1/preflight', headers: { cookie, origin,
        'x-negev-csrf': csrf }, payload: { candidate: { guid: 'synthetic',
        indexerId: 7, title: 'Unverified release', size: 1000 } } });
    assert.equal(preflight.statusCode, 200, preflight.body);
    assert.equal(preflight.json().downloadStarted, false);
    assert.deepEqual(previewed, [1]);
    assert.equal((await app.inject({ method: 'POST',
      url: '/api/requests/1/preflight', headers: { cookie, origin },
      payload: { candidate: { guid: 'synthetic', indexerId: 7,
        title: 'Unverified release', size: 1000 } } })).statusCode, 403);
    const available = await app.inject({ method: 'GET',
      url: '/api/requests/1/episodes/1001/availability', headers: { cookie } });
    assert.equal(available.statusCode, 200);
    assert.deepEqual(available.json(), { state: 'available' });
    assert.deepEqual(observed, [{ anidbId: 1234, episodeId: 1001, kind: 'series' }]);
    knownTitles.delete(1234);
    const direct = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/episodes/1001/availability?kind=series',
      headers: { cookie } });
    assert.deepEqual(direct.json(), { state: 'available' });
    assert.deepEqual(observed.at(-1), { anidbId: 1234,
      episodeId: 1001, kind: 'series' });
    const alternate = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/episodes/1003/availability?kind=series',
      headers: { cookie } });
    assert.deepEqual(alternate.json(), { state: 'available',
      presentation: 'alternate_card' });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/episodes/1001/availability?kind=series',
      headers: { cookie } })).statusCode, 404);
    const display = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/display', headers: { cookie } });
    assert.equal(display.statusCode, 200);
    assert.equal(display.json().description, 'A story about a test.');
    assert.equal(display.json().season, 'Fall 2026');
    assert.equal(display.json().durationMinutes, 23);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/display', headers: { cookie } })).statusCode, 404);
    const checkedPage = await app.inject({ method: 'GET',
      url: '/api/catalogue/1234/availability-page?page=1&offset=0',
      headers: { cookie } });
    assert.equal(checkedPage.statusCode, 200, checkedPage.body);
    assert.deepEqual(checkedPage.json(), { state: 'checked_page', anidbId: 1234,
      page: 1, offset: 0, nextOffset: 5,
      items: [{ episodeId: 1001, state: 'available' },
        { episodeId: 1002, state: 'unknown' },
        { episodeId: 1003, state: 'available' },
        { episodeId: 1004, state: 'available' },
        { episodeId: 1005, state: 'available' }] });
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/requests/1/episodes/1002/availability', headers: { cookie } })).statusCode, 404);
    const mine = await app.inject({ method: 'GET', url: '/api/requests',
      headers: { cookie } });
    assert.deepEqual(mine.json().items.map((item) => item.id), [1]);
    assert.equal((await app.inject({ method: 'GET', url: '/api/requests?limit=1000',
      headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/requests?view=bogus',
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
    const users = await app.inject({ method: 'GET', url: '/api/admin/users',
      headers: { cookie } });
    assert.equal(users.statusCode, 200, users.body);
    assert.equal(users.json().items.find((item) => item.username === 'Friend').adultAllowed, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users',
      headers: { cookie: friendCookie } })).statusCode, 403);
    const adultSetting = await app.inject({ method: 'PATCH',
      url: `/api/admin/users/${register.json().user.id}/adult`,
      headers: { cookie, origin, 'x-negev-csrf': csrf },
      payload: { allowed: false } });
    assert.equal(adultSetting.statusCode, 200, adultSetting.body);
    assert.equal(adultSetting.json().adultAllowed, false);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/admin/review', headers: { cookie: friendCookie } })).statusCode, 403);
    const friendList = await app.inject({ method: 'GET', url: '/api/requests',
      headers: { cookie: friendCookie } });
    assert.deepEqual(friendList.json().items, []);
    const friendSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: friendCookie } });
    assert.equal(friendSession.json().user.adultAllowed, false);
    const deniedAdult = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie: friendCookie, origin,
        'x-negev-csrf': friendSession.json().csrfToken },
      payload: { anidbId: 1235, scope: 'installment', requestKey: 'adult-denied' } });
    assert.equal(deniedAdult.statusCode, 403, deniedAdult.body);
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalogue/1235',
      headers: { cookie: friendCookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalogue/1235/display',
      headers: { cookie: friendCookie } })).statusCode, 403);
    const allowedOrdinary = await app.inject({ method: 'POST', url: '/api/requests',
      headers: { cookie: friendCookie, origin,
        'x-negev-csrf': friendSession.json().csrfToken },
      payload: { anidbId: 1234, scope: 'installment', requestKey: 'ordinary-allowed' } });
    assert.equal(allowedOrdinary.statusCode, 202, allowedOrdinary.body);
    assert.deepEqual(friendSession.json().capabilities, {
      releaseSearch: false, detailLoad: false, availabilityChecks: false,
      acquisitionState: 'reconciliation_held' });
    const memberInvite = await app.inject({ method: 'POST', url: '/api/invitations',
      headers: { cookie: friendCookie, origin,
        'x-negev-csrf': friendSession.json().csrfToken }, payload: {} });
    assert.equal(memberInvite.statusCode, 403);
    const hidden = await app.inject({ method: 'GET', url: '/api/requests/1',
      headers: { cookie: friendCookie } });
    assert.equal(hidden.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/requests/1/candidates', headers: { cookie: friendCookie } })).statusCode, 403);
    assert.deepEqual(discovered, [1]);
    assert.equal((await app.inject({ method: 'POST',
      url: '/api/requests/1/preflight', headers: { cookie: friendCookie,
        origin, 'x-negev-csrf': friendSession.json().csrfToken },
      payload: { candidate: { guid: 'synthetic', indexerId: 7,
        title: 'Unverified release', size: 1000 } } })).statusCode, 403);
    assert.deepEqual(previewed, [1]);
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
