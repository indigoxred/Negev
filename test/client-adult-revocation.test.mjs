import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionController } from '../src/web/public/session-controller.mjs';
import { createApiClient } from '../src/web/public/api-client.mjs';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { acquisitionNotice } from '../src/web/public/acquisition-notice.mjs';

function fixture() {
  const nodes = new Map(), epoch = createResponseEpoch();
  const state = { user: { id: 1, role: 'member', adultAllowed: true }, showAdult: true,
    searchToken: 1, searchItems: new Map([[99, { adult: true }]]), detailHydrationQueued: new Set(), selected: { anidbId: 99 } };
  let reads = 0, renders = 0, time = 1000, allowed = true, preferred = true;
  const cache = new Map([[99, { restricted: true }]]);
  const args = { state, sessionResponses: epoch, displayCache: cache,
    byId: id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, value: '', replaceChildren(...children) { this.children = children; } }); return nodes.get(id); },
    airingResponses: createResponseEpoch(), airingSeasonResponses: createResponseEpoch(), libraryResponses: createResponseEpoch(), reviewResponses: createResponseEpoch(), seasonalResponses: createResponseEpoch(),
    api: async () => { reads++; return { user: { id: 1, role: 'member', adultAllowed: allowed }, csrfToken: 'fresh' }; },
    admin: { resetReview() {} }, auth: {}, browse: { setAiringFilters() {} }, detail: { invalidate() {} }, tracking: { resetTracking() {} },
    genreSelections: { airing: new Set(), season: new Set() }, element: (_tag, text) => ({ text }),
    ensureTrackingPreferences: async () => {}, readAdultPreference: () => preferred, readChinesePreference: () => true, readEnglishTitlePreference: () => false,
    renderRoute: () => { renders++; }, currentAcquisitionNotice: () => '', now: () => time, document: { hidden: false } };
  for (const key of ['applyAdultVisibility','applyPendingLinkCode','applyTitlePreference','dismissRequestDialogs','invalidateRequestResponses','loadOperationalReview','loadRequests','message','renderTrackedTitles','resetRoutePosition','stopBrowsePageObserver','stopLibraryPageObserver','updateRequestScopeButtons']) args[key] = () => {};
  const controller = createSessionController(args);
  return { ...args, controller, cache, epoch, nodes, reads: () => reads, renders: () => renders,
    allow: value => { allowed = value; }, preference: value => { preferred = value; }, advance: ms => { time += ms; } };
}

test('same-account permission revocation clears private metadata and invalidates delayed responses', async () => {
  const f = fixture(), old = f.epoch.current();
  f.byId('library-list').replaceChildren({ text: 'Restricted title' });
  f.allow(false); await f.controller.refreshSession({ background: true });
  assert.equal(f.state.user.adultAllowed, false);
  assert.equal(f.state.showAdult, false);
  assert.equal(f.epoch.isCurrent(old), false);
  assert.equal(f.cache.size, 0);
  assert.equal(f.state.searchItems.size, 0);
  assert.equal(f.state.selected, null);
  assert.equal(f.state.lastSearchQuery, '');
  assert.deepEqual(f.byId('library-list').children, []);
  assert.equal(f.nodes.get('detail').children[0].text, 'Select a result to see its details.');
  f.preference(false); f.allow(true); await f.controller.refreshSession({ background: true });
  assert.equal(f.state.user.adultAllowed, true);
  assert.equal(f.state.showAdult, false, 're-enabling account permission preserves personal hiding');
});

test('session polling coalesces a current read without delaying a newer login generation', async () => {
  const f = fixture(); let complete, calls = 0;
  const controller = createSessionController({ ...f, api: () => {
    calls++; return calls === 1 ? new Promise(resolve => { complete = resolve; }) :
      Promise.resolve({ user: { id: 1, role: 'member', adultAllowed: false } });
  } });
  const old = controller.refreshSession({ background: true });
  controller.refreshSession({ background: true }); assert.equal(calls, 1);
  f.epoch.invalidate();
  const next = controller.refreshSession({ background: true });
  assert.equal(calls, 2);
  await next;
  complete({ user: { id: 1, role: 'member', adultAllowed: true } }); await old;
  assert.equal(f.state.user.adultAllowed, false);
});

test('background session checks preserve unchanged work and bound visible polling', async () => {
  const f = fixture();
  await f.controller.refreshSession({ background: true });
  assert.equal(f.renders(), 0);
  assert.equal(f.state.selected.anidbId, 99);
  await f.controller.refreshVisibleSession();
  assert.equal(f.reads(), 1);
  f.advance(60_000); f.document.hidden = true;
  await f.controller.refreshVisibleSession(); assert.equal(f.reads(), 1);
  f.document.hidden = false;
  await f.controller.refreshVisibleSession(); assert.equal(f.reads(), 2);
});

test('background session checks update runtime notices without resetting current work', async () => {
  const f = fixture();
  f.byId('query').value = 'unfinished search';
  let runtime = 'running';
  const controller = createSessionController({ ...f,
    api: async () => ({ user: { ...f.state.user }, csrfToken: 'fresh',
      capabilities: { acquisitionState: runtime, releaseSearch: true,
        detailLoad: true, titleChecks: true, availabilityChecks: true } }),
    currentAcquisitionNotice: () => acquisitionNotice(f.state.acquisitionState) });
  const generation = f.epoch.current();
  for (const [status, notice] of [['running', /reviewed automatically/],
    ['reconciliation_failed', /paused/], ['waiting_with_review', /Some items need review/]]) {
    runtime = status;
    await controller.refreshSession({ background: true });
    assert.equal(f.state.acquisitionState, status);
    assert.match(f.byId('service-notice').textContent, notice);
    assert.equal(f.byId('query').value, 'unfinished search');
    assert.equal(f.state.selected.anidbId, 99);
    assert.equal(f.renders(), 0);
    assert.equal(f.epoch.isCurrent(generation), true);
  }
  assert.equal(f.state.releaseSearch, true);
  assert.equal(f.state.detailLoad, true);
  assert.equal(f.state.titleChecks, true);
});

test('permission changes invalidate loaded admin settings before rerendering the route', async () => {
  const f = fixture();
  f.state.user.role = 'admin';
  f.state.usersLoaded = true;
  const controller = createSessionController({ ...f,
    renderRoute: () => assert.equal(f.state.usersLoaded, false) });
  controller.showSession({ user: { ...f.state.user, adultAllowed: false }, csrfToken: 'fresh' });
});

test('API permission signal refreshes the current account before resolving and ignores old sessions', async () => {
  const epoch = createResponseEpoch(), state = { user: { id: 1, adultAllowed: true } };
  let refreshes = 0, clears = 0, finish;
  const client = createApiClient({ state, sessionResponses: epoch, clearWorkspace: () => { clears++; },
    refreshSession: async () => { refreshes++; state.user.adultAllowed = false; epoch.invalidate(); },
    fetch: async () => new Response('{}', { status: 403, headers: { 'x-negev-adult-allowed': 'false' } }) });
  await assert.rejects(client.api('/api/catalogue/99/display'));
  assert.equal(refreshes, 1); assert.equal(clears, 0);
  state.user.adultAllowed = true;
  const old = createApiClient({ state, sessionResponses: epoch, refreshSession: async () => { refreshes++; },
    fetch: () => new Promise(resolve => { finish = resolve; }) }).api('/api/catalogue/99');
  epoch.invalidate(); finish(new Response('{}', { status: 403, headers: { 'x-negev-adult-allowed': 'false' } }));
  await assert.rejects(old); assert.equal(refreshes, 1);
});

test('successful filtered responses synchronize permission while ordinary forbidden titles keep the session', async () => {
  const epoch = createResponseEpoch(), state = { user: { id: 1, adultAllowed: true } };
  let refreshes = 0;
  const client = createApiClient({ state, sessionResponses: epoch,
    clearWorkspace: () => assert.fail('permission changes retain sign-in'),
    refreshSession: async () => { refreshes++; state.user.adultAllowed = false; epoch.invalidate(); },
    fetch: async url => url === '/api/library' ? Response.json({ items: [] }, { headers: { 'x-negev-adult-allowed': 'false' } }) :
      Response.json({ reason: 'restricted_or_unverified' }, { status: 403, headers: { 'x-negev-adult-allowed': 'false' } }) });
  assert.deepEqual(await client.api('/api/library'), { items: [] });
  assert.equal(refreshes, 1);
  await assert.rejects(client.api('/api/catalogue/99/display'));
  assert.equal(refreshes, 1, 'an unchanged blocked title does not refresh or sign out');
});
