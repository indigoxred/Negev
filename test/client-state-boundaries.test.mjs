import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { hideChineseProduction } from '../src/web/public/chinese-visibility.mjs';

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
  vm.runInContext(functionSource('api'), context);
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
  const week = createResponseEpoch(), browse = createResponseEpoch();
  const nodes = { 'airing-year': { value: '2026' }, 'airing-season': { value: 'ALL' },
    'airing-kind': { value: 'all' }, 'airing-sort': { value: 'popular_desc' } };
  let submit;
  nodes['airing-form'] = { addEventListener: (_event, listener) => { submit = listener; } };
  const context = vm.createContext({ byId: id => nodes[id], airingResponses: week,
    airingSeasonResponses: browse, sessionResponses: createResponseEpoch(),
    state: { user: { id: 1 } }, genreSelections: { airing: new Set() },
    loadCurrentAiring() {} });
  const start = source.indexOf("byId('airing-form').addEventListener('submit'");
  vm.runInContext(source.slice(start, source.indexOf("\nbyId('airing-sort')", start)), context);
  const pendingWeek = week.current();
  submit({ preventDefault() {} });
  assert.equal(week.isCurrent(pendingWeek), true);
});

test('actual preference read cannot overwrite a newer mutation or same-user session', async () => {
  const pending = deferred();
  const epoch = createResponseEpoch();
  const state = { user: { id: 1 }, airingPreferences: null };
  const context = vm.createContext({ state, sessionResponses: epoch,
    trackingPrefsPromise: null, trackingPreferencesRevision: 0,
    api: () => pending.promise, updateTrackControls() {} });
  vm.runInContext(functionSource('ensureTrackingPreferences'), context);
  const read = context.ensureTrackingPreferences();
  context.trackingPreferencesRevision++;
  state.airingPreferences = { mode: 'custom', trackedAnidbIds: [2] };
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
  vm.runInContext(functionSource('classifySearchCards'), context);
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
    trackingPreferencesRevision: 0, trackingPrefsPromise: null,
    trackingMutationTail: Promise.resolve(), api: async (url, options) => {
      requests.push({ url, ...options }); return pending.promise;
    } });
  vm.runInContext(functionSource('changeTrackingPreferences'), context);
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
  const context = vm.createContext({ byId: () => ({ addEventListener: (_event, fn) => { submit = fn; } }),
    FormData: class { get() { return 'fixture'; } }, sessionResponses: epoch,
    api: async () => ({}), message() {},
    refreshSession: async () => { refreshWasNew = !epoch.isCurrent(old); return true; } });
  const start = source.indexOf("byId('login-form').addEventListener('submit'");
  vm.runInContext(source.slice(start, source.indexOf("\nbyId('register-form')", start)), context);
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(refreshWasNew, true, 'old request generations must end when login succeeds, including same-account login');
});

test('a later failed preference intent preserves an earlier successful saved change', async () => {
  const saved = deferred();
  let calls = 0;
  const state = { user: { id: 1 }, airingPreferences: { mode: 'library', trackedAnidbIds: [] } };
  const context = vm.createContext({ state, sessionResponses: createResponseEpoch(),
    trackingPreferencesRevision: 0, trackingPrefsPromise: null, trackingMutationTail: Promise.resolve(),
    api: async () => { if (++calls === 1) return saved.promise; throw new Error('offline'); } });
  vm.runInContext(functionSource('changeTrackingPreferences'), context);
  const first = context.changeTrackingPreferences({ action: 'track', anidbId: 2 });
  const second = context.changeTrackingPreferences({ action: 'mode', mode: 'all' });
  const rejected = assert.rejects(second, /offline/);
  saved.resolve({ mode: 'library', trackedAnidbIds: [2] });
  await first; await rejected;
  assert.deepEqual(state.airingPreferences, { mode: 'library', trackedAnidbIds: [2] });
});

test('actual sign-out reset prevents an old blocked preference mutation delaying the next session', async () => {
  const node = () => ({ dataset: {}, replaceChildren() {}, reset() {} });
  const nodes = new Map();
  const state = { user: { id: 1 }, detailHydrationQueued: new Set(), searchItems: new Map(), searchToken: 1 };
  let sent = false;
  const context = vm.createContext({ state, sessionResponses: createResponseEpoch(),
    routePositions: new Map(), pendingScrollRestore: null, renderedHash: null,
    stopLibraryPageObserver() {}, stopBrowsePageObserver() {}, invalidateRequestResponses() {},
    reviewResponses: createResponseEpoch(), detailResponses: createResponseEpoch(),
    libraryResponses: createResponseEpoch(), airingResponses: createResponseEpoch(),
    airingSeasonResponses: createResponseEpoch(), seasonalResponses: createResponseEpoch(),
    detailPollTimer: null, dismissRequestDialogs() {}, displayCache: new Map(),
    trackingPrefsPromise: null, trackingPreferencesRevision: 0, trackingSaving: true,
    trackingMutationTail: new Promise(() => {}), genreSelections: { airing: new Set(), season: new Set() },
    nextReviewAttemptId: null, element: () => ({}),
    byId: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    api: async () => { sent = true; return { mode: 'library', trackedAnidbIds: [2] }; } });
  vm.runInContext(functionSource('clearWorkspace') + '\n' + functionSource('changeTrackingPreferences'), context);
  context.clearWorkspace();
  state.user = { id: 2 };
  const write = context.changeTrackingPreferences({ action: 'track', anidbId: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, true);
  assert.equal(await write, true);
});

test('a superseded classification pass cannot resume after visibility toggles back', async () => {
  const checks = [];
  const state = { user: { id: 1 }, searchToken: 1, showAdult: false, showChinese: true, searchItems: new Map() };
  const context = vm.createContext({ state, classificationToken: 0,
    sessionResponses: createResponseEpoch(), location: { hash: '#/discover?q=anime' },
    hideChineseProduction, document: { querySelectorAll: () => [] },
    adultSearchVerifier: { verify: async (_ids, _classify, { current }) => checks.push(current) } });
  vm.runInContext(functionSource('classifySearchCards'), context);
  await context.classifySearchCards(1);
  state.showAdult = true; await context.classifySearchCards(1);
  state.showAdult = false; await context.classifySearchCards(1);
  assert.equal(checks[0](), false, 'old queued passes stay superseded');
  assert.equal(checks.at(-1)(), true);
});

test('actual Airing refresh invalidates both old reads before preferences finish', async () => {
  const pending = deferred(), browse = createResponseEpoch(), oldBrowse = browse.current();
  const context = vm.createContext({ state: { user: { id: 1 } },
    stopBrowsePageObserver() {}, sessionResponses: createResponseEpoch(),
    airingResponses: createResponseEpoch(), airingSeasonResponses: browse,
    byId: () => ({}), ensureTrackingPreferences: () => pending.promise });
  vm.runInContext(functionSource('loadAiring'), context);
  const read = context.loadAiring();
  assert.equal(browse.isCurrent(oldBrowse), false);
  context.sessionResponses.invalidate(); pending.resolve(null); await read;
});
