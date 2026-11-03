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
  let acquisitionState = 'disabled';
  const knownTitles = new Set([1234]);
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
      anidbId, page, kind: 'series', episodes: [
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
        { state: 'available', fileId: 900 }; },
  });
  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.body, /Negev/);
    assert.match(page.body, /Sign in to see acquisition status/);
    assert.match(page.body, /<script src="\/app\.js" type="module"><\/script>/);
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /javascript/);
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
    }
    const unauthorized = await app.inject({ method: 'GET', url: '/api/session' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/admin/review' })).statusCode, 401);
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
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/catalogue/9999/episodes/1001/availability?kind=series',
      headers: { cookie } })).statusCode, 404);
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
    assert.equal((await app.inject({ method: 'GET',
      url: '/api/admin/review', headers: { cookie: friendCookie } })).statusCode, 403);
    const friendList = await app.inject({ method: 'GET', url: '/api/requests',
      headers: { cookie: friendCookie } });
    assert.deepEqual(friendList.json().items, []);
    const friendSession = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: friendCookie } });
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
