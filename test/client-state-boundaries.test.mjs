import { createApiClient } from '../src/web/public/api-client.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { hideChineseProduction } from '../src/web/public/chinese-visibility.mjs';
import { createAdultSearchVerifier } from '../src/web/public/adult-search-visibility.mjs';
import { createCatalogueReadPacer } from '../src/web/public/search-pages.mjs';
import { createAuthController } from '../src/web/public/auth-controller.mjs';
import { createTrackingController } from '../src/web/public/tracking-controller.mjs';
import { createSearchController } from '../src/web/public/search-controller.mjs';
function attachSearch(context) { Object.assign(context, createSearchController({ ...context, verifier: context.adultSearchVerifier })); }
function attachTracking(context) {
  const controller = createTrackingController({ ...context, document: context.document ?? { querySelectorAll: () => [] } });
  Object.assign(context, controller); context.tracking = controller;
}


const source = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  const next = source.indexOf('\n}', start);
  return source.slice(start, next + 2);
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('actual API boundary clears expired session and ignores delayed 401 from old generation', async () => {
  const epoch = createResponseEpoch();
  let clears = 0;
  const old = deferred();
  const context = vm.createContext({ state: { user: { id: 1 } }, sessionResponses: epoch,
    cataloguePacers: {}, AbortSignal, fetch: () => old.promise,
    clearWorkspace: () => { clears++; epoch.invalidate(); },
  });
  Object.assign(context,createApiClient({...context,fetch:(...args)=>context.fetch(...args)}));
  const first = context.api('/api/requests');
  old.resolve({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(first);
  assert.equal(clears, 1);
  const delayed = deferred(); context.fetch = () => delayed.promise;
  const second = context.api('/api/requests');
  epoch.invalidate();
  delayed.resolve({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(second);
  assert.equal(clears, 1);
});

test('actual Airing filter submission leaves pending weekly response current', async () => {
  const { createBrowseFixture } = await import('./helpers/browse-controller-fixture.mjs');
  const week = createResponseEpoch(), season = createResponseEpoch();
  const f = createBrowseFixture({ airingResponses: week, airingSeasonResponses: season });
  for (const [id, value] of [['airing-year', '2026'], ['airing-season', 'ALL'],
    ['airing-kind', 'all'], ['airing-sort', 'popular_desc']]) f.byId(id).value = value;
  const pendingWeek = week.current();
  f.controller.handleAiringSubmit({ preventDefault() {} });
  assert.equal(week.isCurrent(pendingWeek), true);
});
test('actual preference read cannot overwrite a newer mutation or same-user session', async () => {
  const pending = deferred();
  const epoch = createResponseEpoch();
  const state = { user: { id: 1 }, airingPreferences: null };
  const context = vm.createContext({ state, sessionResponses: epoch,
    api: (_url, options) => options?.method === 'PATCH'
      ? Promise.resolve({ mode: 'custom', trackedAnidbIds: [2] }) : pending.promise });
  attachTracking(context);
  const read = context.ensureTrackingPreferences();
  await context.changeTrackingPreferences({ action: 'mode', mode: 'custom' });
  pending.resolve({ mode: 'all', trackedAnidbIds: [] });
  await read;
  assert.deepEqual(state.airingPreferences, { mode: 'custom', trackedAnidbIds: [2] });
});

test('actual search classifier only reads unknown cards when visibility requires it', async () => {
  let reads = [];
  const nodes = [{ dataset: { adult: 'unknown', anidbId: '1', chineseProduction: 'false' } },
    { dataset: { adult: 'unknown', anidbId: '2', chineseProduction: 'true' } }];
  const context = vm.createContext({ state: { user: { id: 1 }, searchToken: 1,
    showAdult: true, showChinese: false, searchItems: new Map() }, classificationToken: 0,
    sessionResponses: createResponseEpoch(), location: { hash: '#/discover?q=anime' },
    hideChineseProduction, document: { querySelectorAll: () => nodes },
    adultSearchVerifier: { verify: async ids => { reads.push(...ids); } } });
  attachSearch(context);
  await context.classifySearchCards(1);
  assert.deepEqual(reads, [], 'adult on needs no adult classification');
  context.state.showAdult = false;
  await context.classifySearchCards(1);
  assert.deepEqual(reads, [1], 'Chinese filtered cards do not consume classification reads');
  reads = []; context.state.showChinese = true;
  await context.classifySearchCards(1);
  assert.deepEqual(reads, [1, 2]);
});

test('actual preference mutations send explicit intent and ignore old-session responses', async () => {
  const requests = [], pending = deferred(), epoch = createResponseEpoch();
  const state = { user: { id: 1 }, airingPreferences: { mode: 'library', trackedAnidbIds: [] } };
  const context = vm.createContext({ state, sessionResponses: epoch,
    api: async (url, options) => {
      requests.push({ url, ...options }); return pending.promise;
    } });
  attachTracking(context);
  const write = context.changeTrackingPreferences({ action: 'track', anidbId: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0].body), { action: 'track', anidbId: 2 });
  epoch.invalidate();
  pending.resolve({ mode: 'library', trackedAnidbIds: [2] });
  assert.equal(await write, false);
  assert.deepEqual(state.airingPreferences.trackedAnidbIds, []);
});

test('successful actual login starts a new generation before reading the authenticated session', async () => {
  const epoch = createResponseEpoch(), old = epoch.current();
  let submit, refreshWasNew = false;
  const form = { reset() {} };
  const context = { byId: () => ({}), state: { user: null }, location: { hash: '' }, history: {},
    FormData: class { get() { return 'fixture'; } }, sessionResponses: epoch,
    api: async () => ({}), message() {},
    refreshSession: async () => { refreshWasNew = !epoch.isCurrent(old); return true; } };
  submit = createAuthController(context).handleLoginSubmit;
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(refreshWasNew, true, 'old request generations must end when login succeeds, including same-account login');
});

test('a later failed preference intent preserves an earlier successful saved change', async () => {
  const saved = deferred();
  let calls = 0;
  const state = { user: { id: 1 }, airingPreferences: { mode: 'library', trackedAnidbIds: [] } };
  const context = vm.createContext({ state, sessionResponses: createResponseEpoch(),
    api: async () => { if (++calls === 1) return saved.promise; throw new Error('offline'); } });
  attachTracking(context);
  const first = context.changeTrackingPreferences({ action: 'track', anidbId: 2 });
  const second = context.changeTrackingPreferences({ action: 'mode', mode: 'all' });
  const rejected = assert.rejects(second, /offline/);
  saved.resolve({ mode: 'library', trackedAnidbIds: [2] });
  await first; await rejected;
  assert.deepEqual(state.airingPreferences, { mode: 'library', trackedAnidbIds: [2] });
});

test('actual sign-out reset prevents an old blocked preference mutation delaying the next session', async () => {
  let change;
  const node = () => ({ dataset: {}, replaceChildren() {}, reset() {}, addEventListener(_event, listener) { change = listener; } });
  const nodes = new Map();
  const state = { user: { id: 1 }, detailHydrationQueued: new Set(), searchItems: new Map(), searchToken: 1 };
  let sent = false, calls = 0;
  const oldMutation = deferred();
  const context = vm.createContext({ state, sessionResponses: createResponseEpoch(),
    routePositions: new Map(), pendingScrollRestore: null, renderedHash: null,
    stopLibraryPageObserver() {}, stopBrowsePageObserver() {}, invalidateRequestResponses() {},
    reviewResponses: createResponseEpoch(), detailResponses: createResponseEpoch(),
    libraryResponses: createResponseEpoch(), airingResponses: createResponseEpoch(),
    airingSeasonResponses: createResponseEpoch(), seasonalResponses: createResponseEpoch(),
    detailPollTimer: null, dismissRequestDialogs() {}, displayCache: new Map(),
    genreSelections: { airing: new Set(), season: new Set() },
    detail: { invalidate() {} }, admin: { resetReview() {} }, browse: { setAiringFilters() {} }, element: () => ({}),
    byId: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    renderTrackedTitles() { assert.fail('old session must not render'); }, updateTrackControls() {}, loadAiring() { assert.fail('old session must not load'); },
    api: async () => { if (++calls === 1) return oldMutation.promise; sent = true; return { mode: 'library', trackedAnidbIds: [2] }; } });
  attachTracking(context); vm.runInContext(functionSource('clearWorkspace'), context);
  const handlerStart = source.indexOf("byId('airing-view-mode').addEventListener('change'");
  vm.runInContext(source.slice(handlerStart, source.indexOf("\nbyId('refresh-requests')", handlerStart)), context);
  const select = context.byId('airing-view-mode');
  state.airingPreferences = { mode: 'library', trackedAnidbIds: [] };
  select.value = 'all';
  const oldChange = change({ currentTarget: select });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(select.disabled, true);
  context.clearWorkspace();
  assert.equal(select.disabled, false, 'the next session has an enabled Airing selector');
  state.user = { id: 2 };
  const write = context.changeTrackingPreferences({ action: 'track', anidbId: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, true);
  assert.equal(await write, true);
  oldMutation.resolve({ mode: 'all', trackedAnidbIds: [99] });
  await oldChange;
  assert.equal(state.airingPreferences.mode, 'library');
  assert.deepEqual(state.airingPreferences.trackedAnidbIds, [2]);
  assert.equal(select.disabled, false);
});

for (const status of [429, 503]) test(`actual client classifier recovers a ${status} with unknown cards hidden until verified`, async () => {
  let now = 0, reads = 0, renders = 0;
  const starts = [];
  const node = { dataset: { adult: 'unknown', anidbId: '1' } };
  const verifier = createAdultSearchVerifier({ now: () => now,
    pacer: createCatalogueReadPacer({ now: () => now, sleep: async ms => { now += ms; } }),
    readDisplay: async id => {
      starts.push(now); reads++;
      assert.equal(node.dataset.adult, 'unknown');
      if (reads === 1) throw Object.assign(new Error('busy'), { status, retryAfter: '12' });
      return { state: 'display', anidbId: id, restricted: false };
    } });
  const context = vm.createContext({ state: { user: { id: 1 }, searchToken: 1,
    showAdult: false, showChinese: true, searchItems: new Map([[1, {}]]) }, classificationToken: 0,
    sessionResponses: createResponseEpoch(), location: { hash: '#/discover?q=anime' },
    hideChineseProduction, document: { querySelectorAll: () => [node] },
    adultSearchVerifier: verifier, applyAdultVisibility: () => { renders++; } });
  attachSearch(context);
  await context.classifySearchCards(1);
  assert.equal(node.dataset.adult, 'false');
  assert.equal(renders, 1);
  assert.deepEqual(starts, [0, 12_000]);
});

for (const transition of ['route', 'session', 'toggle', 'expiry']) test(`actual client classification retry cancels after ${transition}`, async () => {
  let now = 0, reads = 0;
  const pause = deferred();
  const node = { dataset: { adult: 'unknown', anidbId: '1' } };
  const epoch = createResponseEpoch();
  const state = { user: { id: 1 }, searchToken: 1, showAdult: false, showChinese: true, searchItems: new Map() };
  const location = { hash: '#/discover?q=anime' };
  const verifier = createAdultSearchVerifier({ now: () => now,
    pacer: createCatalogueReadPacer({ now: () => now, sleep: async ms => { await pause.promise; now += ms; } }),
    readDisplay: async () => { reads++; throw Object.assign(new Error('busy'), { status: 503, retryAfter: transition === 'expiry' ? '181' : '5' }); } });
  const context = vm.createContext({ state, classificationToken: 0, sessionResponses: epoch, location,
    hideChineseProduction, document: { querySelectorAll: () => [node] }, adultSearchVerifier: verifier,
    applyAdultVisibility() { assert.fail('unknown must stay hidden'); } });
  attachSearch(context);
  const run = context.classifySearchCards(1);
  await new Promise(resolve => setImmediate(resolve));
  if (transition === 'route') location.hash = '#/library';
  if (transition === 'session') { epoch.invalidate(); state.user = { id: 1 }; }
  if (transition === 'toggle') { state.showAdult = true; await context.classifySearchCards(1); state.showAdult = false; }
  pause.resolve(); await run;
  assert.equal(reads, 1);
  assert.equal(node.dataset.adult, 'unknown');
});

test('actual classifier rejects a successful old-session response before caching or rendering it', async () => {
  const pending = deferred(), epoch = createResponseEpoch();
  const node = { dataset: { adult: 'unknown', anidbId: '1' } };
  let reads = 0;
  const verifier = createAdultSearchVerifier({ pacer: { run: read => read(), defer() {} }, readDisplay: async id => {
    if (++reads === 1) return pending.promise;
    return { state: 'display', anidbId: id, restricted: false };
  } });
  const state = { user: { id: 1 }, searchToken: 1, showAdult: false, showChinese: true, searchItems: new Map() };
  const context = vm.createContext({ state, classificationToken: 0, sessionResponses: epoch, location: { hash: '#/discover' },
    hideChineseProduction, document: { querySelectorAll: () => [node] }, adultSearchVerifier: verifier, applyAdultVisibility() {} });
  attachSearch(context);
  const run = context.classifySearchCards(1);
  epoch.invalidate();
  pending.resolve({ state: 'display', anidbId: 1, restricted: false });
  await run;
  assert.equal(node.dataset.adult, 'unknown');
  await context.classifySearchCards(1);
  assert.equal(reads, 2, 'an obsolete success is not cached for a later session');
  assert.equal(node.dataset.adult, 'false');
});

test('a superseded classification pass cannot resume after visibility toggles back', async () => {
  const checks = [];
  const state = { user: { id: 1 }, searchToken: 1, showAdult: false, showChinese: true, searchItems: new Map() };
  const context = vm.createContext({ state, classificationToken: 0,
    sessionResponses: createResponseEpoch(), location: { hash: '#/discover?q=anime' },
    hideChineseProduction, document: { querySelectorAll: () => [] },
    adultSearchVerifier: { verify: async (_ids, _classify, { current }) => checks.push(current) } });
  attachSearch(context);
  await context.classifySearchCards(1);
  state.showAdult = true; await context.classifySearchCards(1);
  state.showAdult = false; await context.classifySearchCards(1);
  assert.equal(checks[0](), false, 'old queued passes stay superseded');
  assert.equal(checks.at(-1)(), true);
});

test('actual Airing refresh invalidates both old reads before preferences finish', async () => {
  const { createBrowseFixture } = await import('./helpers/browse-controller-fixture.mjs');
  const pending = deferred(), browse = createResponseEpoch(), oldBrowse = browse.current();
  const f = createBrowseFixture({ airingSeasonResponses: browse,
    ensureTrackingPreferences: () => pending.promise });
  const read = f.controller.loadAiring();
  assert.equal(browse.isCurrent(oldBrowse), false);
  f.deps.sessionResponses.invalidate(); pending.resolve(null); await read;
});


