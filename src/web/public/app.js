import { createRequestController } from './request-controller.mjs';
import { createAdminController } from './admin-controller.mjs';
import { createViewHelpers } from './view-helpers.mjs';
import { catalogueAvailability } from './card-availability.mjs';

import { createReleaseDialog, makeReleaseActions } from './release-dialog.mjs';
import { createRequestKeyStore, generateRequestKey } from './request-key.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { createSearchPager, observeCatalogueContinuation, createCataloguePrefetchBudget, createCatalogueReadPacer } from './search-pages.mjs';

import { createAdultSearchVerifier } from './adult-search-visibility.mjs';

import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';
import { createResponseEpoch } from './response-epoch.mjs';
import { createFranchiseExplorer, createRelatedDetailCache, expandFranchiseBatch,
  groupFranchiseItems } from './franchise-explorer.mjs';
import { acquisitionNotice } from './acquisition-notice.mjs';
import { titleAvailabilitySummary,
  installmentRequestState, filmEntryRequestState } from './season-availability-presentation.mjs';
import { episodeScheduleLabel, nextAirDateLabel } from './episode-schedule.mjs';
import { trackingAction } from './airing-tracking-controls.mjs';
import { canOpenSeasonRequest, relatedAvailabilityText, seasonRequestStatus,
  seasonSelectionSummary, seasonSelectionScope, seasonTriggerPresentation } from './season-request-selection.mjs';
import { relationLabel } from './relation-label.mjs';
import { detailOriginalTitle, detailAliasText } from './title-preference.mjs';
import { hideChineseProduction } from './chinese-visibility.mjs';
import { parseConsumerRoute, searchRoute, librarySearchRoute, titleRoute,
  seasonRoute, browseReturnDestination, requestRoute } from './consumer-route.mjs';

const byId = (id) => document.getElementById(id);
// Invitation and password reset links carry their one-time code in the URL
// fragment, which browsers never send to the server. Read it once and remove
// it from the address bar before routing starts.
let pendingLinkCode = (() => {
  const match = /^#(invite|reset)=([a-f0-9]{64})$/i.exec(location.hash);
  if (!match) return null;
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch { /* The code still applies; it only stays visible in the address bar. */ }
  return { kind: match[1].toLowerCase(), code: match[2].toLowerCase() };
})();
const requestKeys = createRequestKeyStore({ storage: sessionStorage,
  createKey: generateRequestKey });
const state = { csrf: null, user: null, selected: null,
  nextBeforeId: { watching: null, history: null, preparing: null },
  releaseSearch: false, detailLoad: false,
  titleChecks: false, acquisitionState: 'disabled', searchToken: 0,
  lastSearchQuery: '', lastBrowseDestination: { href: '#/discover',
    label: 'Discover' }, searchItems: new Map(),
  libraryLoaded: false, libraryAfter: null, airingLoaded: false,
  airingPreferences: null,
  seasonalRouteKey: null, routePage: null,
  requestHistoryExpanded: false, focusedRequestId: null,
  requestScope: 'mine',
  showAdult: true, showChinese: true, preferEnglish: false, usersLoaded: false,
  detailHydrationQueued: new Set() };
const sessionResponses = createResponseEpoch();
const requestResponses = {
  watching: createResponseEpoch(), history: createResponseEpoch(),
  preparing: createResponseEpoch(),
};
const displayCache = new Map();
let classificationToken = 0;
const adultSearchVerifier = createAdultSearchVerifier({ readDisplay: (id) =>
  api(`/api/catalogue/${id}/display`, { signal: AbortSignal.timeout(30_000) }) });
function invalidateRequestResponses() {
  requestResponses.watching.invalidate();
  requestResponses.history.invalidate();
  requestResponses.preparing.invalidate();
}
const reviewResponses = createResponseEpoch();
const detailResponses = createResponseEpoch();
const libraryResponses = createResponseEpoch();
const airingResponses = createResponseEpoch();
const airingSeasonResponses = createResponseEpoch();
const seasonalResponses = createResponseEpoch();

let detailPollTimer = null;
let trackingPrefsPromise = null;
let trackingSaving = false;
let trackingPreferencesRevision = 0;
let trackingMutationTail = Promise.resolve();
const genreSelections = { season: new Set(), airing: new Set() };
const dropdownSelector = '#identity[open], #tracked-titles[open], .genre-picker[open]';
document.querySelector('.skip-link')?.addEventListener('click', event => {
  event.preventDefault();
  byId('main-content').focus();
});
// Native showModal/close restores the visible title action through nested pickers.
const routePositions = new Map();
let renderedHash = null;
let pendingScrollRestore = null;
function restoreRoutePosition() {
  if (!pendingScrollRestore || pendingScrollRestore.hash !== location.hash) return;
  const { y } = pendingScrollRestore;
  if (y > 0 && document.documentElement.scrollHeight < y + window.innerHeight - 1) return;
  pendingScrollRestore = null;
  window.scrollTo({ top: y, behavior: 'instant' });
}
for (const type of ['wheel', 'touchstart', 'pointerdown']) window.addEventListener(type,
  () => { pendingScrollRestore = null; }, { passive: true });
window.addEventListener('scroll', () => {
  if (renderedHash && renderedHash === location.hash && !pendingScrollRestore) routePositions.set(renderedHash, window.scrollY);
}, { passive: true });
document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll(dropdownSelector)) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of document.querySelectorAll(dropdownSelector)) {
    const hadFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (hadFocus) menu.querySelector('summary')?.focus();
  }
});
let airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
const viewHelpers = createViewHelpers({ byId, state });
const { message, element, preferredDisplayTitle, titleLabel, applyTitlePreference, posterImage } = viewHelpers;
const currentAcquisitionNotice = () => acquisitionNotice(state.acquisitionState);




function updateTrackControls() {
  for (const button of document.querySelectorAll('[data-track-id]')) {
    const id = Number(button.dataset.trackId);
    button.textContent = trackingAction(state.airingPreferences, id);
    button.disabled = !state.airingPreferences || trackingSaving;
    button.setAttribute('aria-pressed', String(Boolean(
      state.airingPreferences?.trackedAnidbIds.includes(id))));
    button.setAttribute('aria-label', `${button.textContent}: ${button.dataset.trackTitle}`);
  }
}
async function ensureTrackingPreferences() {
  if (state.airingPreferences) return state.airingPreferences;
  const userId = state.user?.id;
  if (!userId) return null;
  if (trackingPrefsPromise) return trackingPrefsPromise;
  const session = sessionResponses.current();
  const revision = trackingPreferencesRevision;
  const pending = api('/api/airing/preferences').then((preferences) => {
    if (sessionResponses.isCurrent(session) && state.user?.id === userId &&
        revision === trackingPreferencesRevision) {
      state.airingPreferences = preferences;
      updateTrackControls();
    }
    return sessionResponses.isCurrent(session) ? state.airingPreferences : null;
  }).finally(() => {
    if (trackingPrefsPromise === pending) trackingPrefsPromise = null;
  });
  trackingPrefsPromise = pending;
  return trackingPrefsPromise;
}
async function changeTrackingPreferences(action) {
  const session = sessionResponses.current();
  trackingPreferencesRevision++;
  trackingPrefsPromise = null;
  const pending = trackingMutationTail.catch(() => {}).then(async () => {
    if (!sessionResponses.isCurrent(session) || !state.user) return false;
    const preferences = await api('/api/airing/preferences', {
      method: 'PATCH', body: JSON.stringify(action) });
    if (!sessionResponses.isCurrent(session)) return false;
    trackingPreferencesRevision++;
    state.airingPreferences = preferences;
    return true;
  });
  trackingMutationTail = pending;
  return pending;
}
function refreshTrackingAfterRequest() {
  trackingPreferencesRevision++;
  state.airingPreferences = null;
  trackingPrefsPromise = null;
  updateTrackControls();
  void ensureTrackingPreferences().then(renderTrackedTitles).catch(() => {});
}
function makeTrackButton(item) {
  const button = element('button', trackingAction(state.airingPreferences,
    item.anidbId), 'quiet track-toggle');
  button.type = 'button';
  button.dataset.trackId = String(item.anidbId);
  button.dataset.trackTitle = item.title;
  button.disabled = !state.airingPreferences;
  button.setAttribute('aria-pressed', String(Boolean(
    state.airingPreferences?.trackedAnidbIds.includes(item.anidbId))));
  button.setAttribute('aria-label', `${button.textContent}: ${item.title}`);
  button.addEventListener('click', async () => {
    if (trackingSaving) return;
    const session = sessionResponses.current();
    const current = state.airingPreferences;
    if (!current) return;
    const action = current.trackedAnidbIds.includes(item.anidbId) ? 'untrack' : 'track';
    trackingSaving = true;
    updateTrackControls();
    try {
      if (!await changeTrackingPreferences({ action, anidbId: item.anidbId })) return;
      updateTrackControls();
      renderTrackedTitles();
      if (state.routePage === 'airing' && current.mode === 'custom') void loadAiring();
    } catch (error) { if (sessionResponses.isCurrent(session)) message(error.message, true); }
    finally { if (sessionResponses.isCurrent(session)) { trackingSaving = false; updateTrackControls(); } }
  });
  if (!state.airingPreferences) void ensureTrackingPreferences().catch(() => {
    button.textContent = 'Tracking unavailable';
    button.disabled = true;
  });
  return button;
}
function trackedCard(card, item, { hideUnknown = false } = {}) {
  const wrapper = markAdult(element('div', undefined, 'tracked-title'), item,
    { hideUnknown });
  // The wrapper owns visibility and identity so a card counts only once.
  delete card.dataset.anidbId;
  delete card.dataset.adult;
  delete card.dataset.chineseProduction;
  card.hidden = false;
  wrapper.append(card);
  return wrapper;
}
function renderTrackedTitles() {
  const list = byId('tracked-titles-list');
  const panel = byId('tracked-titles');
  if (!list || !panel || !state.airingPreferences) return;
  const ids = state.airingPreferences.trackedAnidbIds;
  byId('tracked-count').textContent = `(${ids.length})`;
  list.replaceChildren();
  if (!ids.length) {
    list.append(element('p', 'No titles tracked yet. Search or browse, then choose Track this title.', 'muted'));
    return;
  }
  let shown = 0;
  const appendPage = () => {
    const end = Math.min(shown + 20, ids.length);
    const userId = state.user?.id;
    for (const id of ids.slice(shown, end)) {
      const known = state.searchItems.get(id);
      const title = known?.title && !/^Anime \d+$/.test(known.title)
        ? known.title : `AniDB ${id}`;
      const item = { anidbId: id, title, adult: known?.adult,
        chineseProduction: known?.chineseProduction };
      const row = markAdult(element('div', undefined, 'tracked-list-row'), item);
      const link = element('a', title, 'text-link');
      link.href = titleRoute(id);
      row.append(link, makeTrackButton(item));
      list.append(row);
      if (title === `AniDB ${id}` && panel.open) {
        void api(`/api/catalogue/${id}/display`).then((display) => {
          if (state.user?.id !== userId || !row.isConnected ||
              display?.state !== 'display') return;
          link.textContent = display.title;
          row.querySelector('[data-track-id]').dataset.trackTitle = display.title;
          state.searchItems.set(id, { anidbId: id, title: display.title,
            adult: display.restricted });
          row.dataset.adult = String(display.restricted);
          applyAdultVisibility();
          updateTrackControls();
        }).catch(() => {});
      }
    }
    shown = end;
    if (shown < ids.length) {
      const more = element('button', 'Show more tracked titles', 'quiet');
      more.type = 'button';
      more.addEventListener('click', () => { more.remove(); appendPage(); });
      list.append(more);
    }
  };
  appendPage();
}
byId('tracked-titles').addEventListener('toggle', () => {
  if (byId('tracked-titles').open) renderTrackedTitles();
});
function adultPreferenceKey(userId) { return `negev:show-adult:${userId}`; }
function readAdultPreference(userId) {
  try { return localStorage.getItem(adultPreferenceKey(userId)) !== 'off'; }
  catch { return true; }
}
function chinesePreferenceKey(userId) { return `negev:show-chinese:${userId}`; }
function readChinesePreference(userId) {
  try { return localStorage.getItem(chinesePreferenceKey(userId)) !== 'off'; }
  catch { return true; }
}
function englishTitlePreferenceKey(userId) { return `negev:english-titles:${userId}`; }
function readEnglishTitlePreference(userId) {
  try { return localStorage.getItem(englishTitlePreferenceKey(userId)) === 'on'; }
  catch { return false; }
}
function markAdult(node, item, { hideUnknown = false } = {}) {
  node.dataset.anidbId = String(item.anidbId);
  node.dataset.adult = item.adult === true ? 'true' :
    item.adult === false ? 'false' : 'unknown';
  node.dataset.chineseProduction = String(item.chineseProduction === true);
  node.hidden = !state.showAdult && (item.adult === true ||
    hideUnknown && item.adult !== false) ||
    hideChineseProduction(state.showChinese, item.chineseProduction);
  return node;
}
function applyAdultVisibility() {
  for (const node of document.querySelectorAll('[data-anidb-id]')) {
    const known = state.searchItems.get(Number(node.dataset.anidbId));
    node.hidden = !state.showAdult && (node.dataset.adult === 'true' ||
      state.searchItems.get(Number(node.dataset.anidbId))?.adult === true ||
      (node.closest('#results') || node.closest('#library-search-results')) &&
        node.dataset.adult !== 'false') ||
      hideChineseProduction(state.showChinese,
        node.dataset.chineseProduction === 'true' || known?.chineseProduction);
  }
  const toggle = byId('adult-toggle');
  toggle.textContent = state.user?.adultAllowed === false ? '18+ titles blocked' : 'Show 18+ titles';
  toggle.setAttribute('aria-pressed', String(state.showAdult));
  toggle.disabled = state.user?.adultAllowed === false;
  toggle.title = toggle.disabled ? '18+ access is disabled for this account' :
    'Show or hide titles marked 18+';
  const chinese = byId('chinese-toggle');
  chinese.querySelector('span').textContent = 'Show Chinese productions';
  chinese.setAttribute('aria-pressed', String(state.showChinese));
  chinese.title = 'Show or hide titles tagged Chinese production';
}


function renderRoute() {
  if (!state.user) return;
  const route = parseConsumerRoute(location.hash);
  const previousRoute = renderedHash === null ? null : parseConsumerRoute(renderedHash);
  const librarySearchCleared = route.page === 'library' && route.query.length < 2 &&
    previousRoute?.page === 'library' && previousRoute.query.length >= 2;
  if (renderedHash !== location.hash) {
    classificationToken++;
    message('');
    for (const menu of document.querySelectorAll(dropdownSelector)) menu.open = false;
    pendingScrollRestore = { hash: location.hash, y: routePositions.get(location.hash) ?? 0 };
    renderedHash = location.hash;
    stopLibraryPageObserver();
    stopBrowsePageObserver('discover');
    stopBrowsePageObserver('airing');
    state.seasonalRouteKey = null;
    state.airingLoaded = false;
  }
  const page = route.page === 'admin' && state.user.role !== 'admin'
    ? 'discover' : route.page;
  const returning = state.routePage !== null && state.routePage !== page;
  const focusChanged = state.focusedRequestId !== (route.requestId ?? null);
  state.focusedRequestId = route.requestId ?? null;
  if (returning || page === 'title' && state.selected !== route.anidbId) {
    dismissRequestDialogs();
  }
  state.routePage = page;
  document.body.dataset.page = page;
  const browseDestination = browseReturnDestination(route);
  if (browseDestination) state.lastBrowseDestination = browseDestination;
  for (const name of ['discover', 'airing', 'library', 'requests', 'title', 'admin']) {
    byId(`view-${name}`).hidden = name !== page;
  }
  restoreRoutePosition();
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `Negev · ${page[0].toUpperCase()}${page.slice(1)}`;
  if (page === 'title') {
    byId('back-to-discover').href = state.lastBrowseDestination.href;
    byId('back-to-discover').textContent =
      `← Back to ${state.lastBrowseDestination.label}`;
    if (state.selected !== route.anidbId) {
      const item = state.searchItems.get(route.anidbId) ??
        { anidbId: route.anidbId, title: `Anime ${route.anidbId}` };
      void showDetail(item);
    }
  } else {
    if (state.selected !== null) {
      detailResponses.invalidate();
      if (detailPollTimer !== null) clearTimeout(detailPollTimer);
      detailPollTimer = null;
      state.selected = null;
    }
  }
  if (page === 'discover' || page === 'library') {
    byId('query').value = route.query;
    if (page === 'discover') byId('discover-query').value = route.query;
    if (page === 'library') byId('library-query').value = route.query;
    const searching = route.query.length >= 2;
    if(page==='discover'){document.querySelector('.discover-workbench').dataset.searching=String(searching);byId('discover-clear-search').hidden=!searching;}
    byId('catalogue-browse').hidden = page === 'discover' && searching;
    byId('search-results-section').hidden = page !== 'discover' || !searching;
    byId('library-search-section').hidden = page !== 'library' || !searching;
    byId('library-browse').hidden = page === 'library' && searching;
    if(page==='library')byId('library-state').hidden=searching;
    if (page === 'library') byId('search-all-catalogue').href = searchRoute(route.query);
    else byId('search-verified-library').href = librarySearchRoute(route.query);
    if (route.query.length >= 2 &&
        (returning || `${page}:${route.query}` !== state.lastSearchQuery)) {
      byId('search-form').requestSubmit();
    }
  }
  if (page === 'discover' && route.query.length < 2) {
    const choice = seasonChoice(route);
    const key = `${choice.year}-${choice.season}-${choice.after}-${choice.kind}-${choice.tag}-${choice.sort}`;
    if (state.seasonalRouteKey !== key) {
      state.seasonalRouteKey = key;
      void loadSeasonal(choice);
    }
  } else if (page === 'library' && route.query.length < 2 &&
      (returning || librarySearchCleared || !state.libraryLoaded)) {
    void loadLibrary();
  } else if (page === 'requests' && (returning || focusChanged)) {
    const focus = byId('request-focus');
    focus.hidden = !state.focusedRequestId;
    focus.replaceChildren();
    if (state.focusedRequestId) {
      state.requestScope = state.user.role === 'admin' ? 'all' : 'mine';
      updateRequestScopeButtons();
      const clear = element('a','Show all requests','text-link');clear.href='#/requests';
      focus.append(element('span',`Request #${state.focusedRequestId} · `),clear);
      byId('request-history').hidden=false;
      byId('request-watching').hidden=true;
      for(const tab of document.querySelectorAll('[data-request-tab]'))
        tab.setAttribute('aria-selected',String(tab.dataset.requestTab!=='watching'));
    }
    void loadRequests();
  } else if (page === 'airing') {
    if (!state.airingLoaded) void loadAiring();
  } else if (page === 'admin' && !state.usersLoaded) {
    void loadUsers();
    void loadInvites();
  }
}
window.addEventListener('hashchange', renderRoute);
window.addEventListener('popstate', renderRoute);
for (const tab of document.querySelectorAll('[data-request-tab]')) {
  tab.addEventListener('click', () => {
    if (state.focusedRequestId) location.hash='#/requests';
    const watching = tab.dataset.requestTab === 'watching';
    byId('request-history').hidden = watching;
    byId('request-watching').hidden = !watching;
    for (const button of document.querySelectorAll('[data-request-tab]')) {
      button.setAttribute('aria-selected', String(button === tab));
    }
  });
}
function updateRequestScopeButtons() {
  for (const button of document.querySelectorAll('[data-request-scope]')) {
    button.setAttribute('aria-pressed', String(button.dataset.requestScope === state.requestScope));
  }
  byId('history-title').textContent = state.requestScope === 'all'
    ? 'All anime requests' : 'Your requests';
}
for (const button of document.querySelectorAll('[data-request-scope]')) {
  button.addEventListener('click', () => {
    if (state.user?.role !== 'admin' || state.requestScope === button.dataset.requestScope) return;
    state.requestScope = button.dataset.requestScope;
    state.requestHistoryExpanded = false;
    invalidateRequestResponses();
    updateRequestScopeButtons();
    loadRequests();
  });
}
const cataloguePacers = { seasons: createCatalogueReadPacer(), library: createCatalogueReadPacer() };
async function api(url, options = {}) {
  const { catalogueCurrent, ...fetchOptions } = options;
  const pacer = /^\/api\/seasons(?:\?|$)/.test(url) ? cataloguePacers.seasons :
    /^\/api\/library(?:\?|$)/.test(url) ? cataloguePacers.library : null;
  const userId = state.user?.id;
  const session = sessionResponses.current();
  const read = async () => {
    const headers = { Accept: 'application/json', ...fetchOptions.headers };
    if (fetchOptions.body !== undefined) headers['Content-Type'] = 'application/json';
    if (fetchOptions.method && fetchOptions.method !== 'GET' && state.csrf) headers['x-negev-csrf'] = state.csrf;
    const signal = fetchOptions.signal ?? (pacer ? AbortSignal.timeout(30_000) : undefined);
    const response = await fetch(url, { credentials: 'same-origin', ...fetchOptions, headers, signal });
    const data = await response.json().catch(() => ({}));
    if (pacer && [429, 503].includes(response.status)) pacer.defer(response.headers.get('Retry-After'), response.status === 429 ? 60_000 : 5000);
    if (pacer && data.state === 'unavailable') pacer.defer(null, 30_000);
    if (!response.ok) {
      if (data.reason === 'request_cancelled' && sessionResponses.isCurrent(session) &&
          state.user?.id === userId && ['/api/requests', '/api/release-previews'].includes(url)) {
        const body = JSON.parse(fetchOptions.body ?? '{}');
        const selections = body.scope === 'episodes' && body.episodeIds?.length === 1
          ? [`episode-${body.episodeIds[0]}`, `film-entry-${body.episodeIds[0]}`] : ['installment'];
        for (const selection of selections) requestKeys.rejected({ userId,
          anidbId: body.anidbId, selection }, data, body.requestKey);
      }
      if (response.status === 401 && !['/api/login', '/api/register'].includes(url) &&
          sessionResponses.isCurrent(session)) clearWorkspace();
      const error = new Error(data.error || data.reason || 'Request failed ('+response.status+')');
      error.status = response.status; error.reason = data.reason; error.field = data.field;
      error.retryAfter = response.headers?.get('Retry-After'); throw error;
    }
    return data;
  };
  return pacer ? pacer.run(read, catalogueCurrent ?? (() => sessionResponses.isCurrent(session) && state.user?.id === userId)) : read();
}
const releasePreviewSaved=new Map();
const releaseDialog=createReleaseDialog({api,element,onSaved:data=>{
  if(data?.previewId&&(!Number.isSafeInteger(data.requestId)||data.requestId<1))return;
  const saved=releasePreviewSaved.get(data?.previewId);
  if(saved){releasePreviewSaved.delete(data.previewId);saved(data);refreshTrackingAfterRequest();}
  void loadRequests();
}});
function dismissRequestDialogs() {
  releaseDialog.close();
  // Hiding an ancestor does not close a native modal: it still makes the
  // newly visible page inert. Release the top layer before changing views.
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}
async function openPreviewReleaseRequests(jobs) {
  if(!state.releaseSearch)return;
  const session=sessionResponses.current(),route=location.hash;
  const show=async index=>{
    if(!state.user||!sessionResponses.isCurrent(session)||location.hash!==route)return;
    const item=jobs[index];if(!item)return;
    try{
      const preview=await api('/api/release-previews',{method:'POST',body:JSON.stringify(item.body)});
      if(!state.user||!sessionResponses.isCurrent(session)||location.hash!==route)return;
      if(preview.state==='pending') {
        item.saved(preview);refreshTrackingAfterRequest();void loadRequests();
        message(savedRequestMessage(preview));
        if(index+1<jobs.length)void show(index+1);
        return;
      }
      if(preview.state==='existing') {
        item.saved(preview);refreshTrackingAfterRequest();void loadRequests();
        void releaseDialog.open({requestId:preview.requestId,title:preferredDisplayTitle(item),existing:true,
          next:index+1<jobs.length?()=>{void show(index+1);}:null});
        return;
      }
      if(preview.state!=='preview'||typeof preview.previewId!=='string')throw new Error(preview.reason??'Release preview unavailable');
      while(releasePreviewSaved.size>=100)releasePreviewSaved.delete(releasePreviewSaved.keys().next().value);
      const previewUserId=state.user.id;
      releasePreviewSaved.set(preview.previewId,result=>{
        if(state.user?.id===previewUserId)item.saved(result);
      });
      void releaseDialog.open({previewId:preview.previewId,title:preferredDisplayTitle(item),mode:'manual',
        next:index+1<jobs.length?()=>{void show(index+1);}:null});
    }catch(error){
      message(requestFailureMessage(error),true);
      if(![401,403].includes(error.status)&&
          (error.reason??error.message)!=='account_access_changed'&&index+1<jobs.length)await show(index+1);
    }
  };
  await show(0);
}
async function openSavedReleaseRequests(saved,mode) {
  if(!state.releaseSearch)return;
  const session = sessionResponses.current();
  const route = location.hash;
  const jobs=saved.filter(item=>Number.isSafeInteger(item.requestId));
  const show=index=>{
    if(!state.user || !sessionResponses.isCurrent(session) || location.hash!==route)return;
    const item=jobs[index];if(!item)return;
    void releaseDialog.open({requestId:item.requestId,title:preferredDisplayTitle(item),
      mode:mode==='manual'?'manual':'auto',
      next:index+1<jobs.length?()=>show(index+1):null});
  };
  show(0);
}
function showSession(data) {
  if (state.user?.id !== data.user.id) {
    dismissRequestDialogs();
    sessionResponses.invalidate();
    invalidateRequestResponses();
    reviewResponses.invalidate();
    detailResponses.invalidate();
    if (detailPollTimer !== null) clearTimeout(detailPollTimer);
    detailPollTimer = null;
    stopLibraryPageObserver();
    stopBrowsePageObserver('discover');
    stopBrowsePageObserver('airing');
    libraryResponses.invalidate();
    airingResponses.invalidate();
    airingSeasonResponses.invalidate();
    seasonalResponses.invalidate();
    state.selected = null;
    state.detailHydrationQueued.clear();
    displayCache.clear();
    byId('request-list').replaceChildren();
    byId('preparing-list').replaceChildren();
    byId('more-preparations').hidden = true;
    byId('watch-list').replaceChildren();
    byId('review-list').replaceChildren();
    byId('detail').replaceChildren(element('p',
      'Select a result to see its details.', 'muted'));
    state.nextBeforeId = { watching: null, history: null, preparing: null };
    state.requestHistoryExpanded = false;
    state.requestScope = data.user.role === 'admin' ? 'all' : 'mine';
    state.libraryLoaded = false;
    state.libraryAfter = null;
    state.airingLoaded = false;
    state.airingPreferences = null;
    trackingPrefsPromise = null;
    trackingPreferencesRevision++;
    trackingMutationTail = Promise.resolve();
    trackingSaving = false;
    byId('airing-view-mode').disabled = false;
    airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
    genreSelections.airing.clear();
    genreSelections.season.clear();
    state.seasonalRouteKey = null;
    state.routePage = null;
    admin.resetReview();
  }
  state.user = data.user;
  void ensureTrackingPreferences().then(renderTrackedTitles).catch(() => {});
  state.showAdult = data.user.adultAllowed !== false &&
    readAdultPreference(data.user.id);
  state.showChinese = readChinesePreference(data.user.id);
  state.preferEnglish = readEnglishTitlePreference(data.user.id);
  state.csrf = data.csrfToken;
  state.releaseSearch = data.capabilities?.releaseSearch === true;
  state.detailLoad = data.capabilities?.detailLoad === true;
  state.titleChecks = data.capabilities?.titleChecks === true;
  state.acquisitionState = data.capabilities?.acquisitionState || 'disabled';
  byId('service-notice').textContent = data.capabilities?.availabilityChecks === true
    ? `Negev is in preview. ${currentAcquisitionNotice()} Public Plex availability can be checked; an unconfirmed result does not mean a file is missing.`
    : `Negev is in preview. ${currentAcquisitionNotice()} Public Plex checks are not active.`;
  byId('auth').hidden = true;
  byId('session-loading').hidden = true;
  byId('workspace').hidden = false;
  if (pendingLinkCode) {
    message(pendingLinkCode.kind === 'invite'
      ? 'You opened an invitation link while signed in. Sign out first if it is for a new account.'
      : 'You opened a password reset link while signed in. Sign out first to use it.');
  }
  byId('main-nav').hidden = false;
  byId('mobile-nav').hidden = false;
  byId('search-form').hidden = false;
  byId('identity').hidden = false;
  byId('browse-preferences').hidden = false;
  byId('adult-toggle').hidden = false;
  byId('chinese-toggle').hidden = false;
  applyAdultVisibility();
  applyTitlePreference();
  byId('username').textContent = data.user.username;
  byId('profile-initial').textContent = String(data.user.username).slice(0,1).toUpperCase();
  byId('invite').hidden = data.user.role !== 'admin';
  byId('admin-link').hidden = data.user.role !== 'admin';
  byId('admin-review').hidden = data.user.role !== 'admin';
  byId('request-scope').hidden = data.user.role !== 'admin';
  byId('requests-heading').textContent = 'Requests';
  byId('requests-description').textContent = data.user.role === 'admin'
    ? 'Follow everyone’s anime requests.' : 'Follow your anime requests.';
  updateRequestScopeButtons();
  renderRoute();
}
function clearWorkspace() {
  routePositions.clear();
  pendingScrollRestore = null;
  renderedHash = null;
  for (const id of ['results', 'library-search-results']) {
    delete byId(id).dataset.query;
    delete byId(id).dataset.complete;
  }
  stopLibraryPageObserver();
  stopBrowsePageObserver('discover');
  stopBrowsePageObserver('airing');
  sessionResponses.invalidate();
  invalidateRequestResponses();
  reviewResponses.invalidate();
  detailResponses.invalidate();
  if (detailPollTimer !== null) clearTimeout(detailPollTimer);
  detailPollTimer = null;
  libraryResponses.invalidate();
  airingResponses.invalidate();
  airingSeasonResponses.invalidate();
  seasonalResponses.invalidate();
  dismissRequestDialogs();
  state.user = null;
  state.requestScope = 'mine';
  state.showAdult = true;
  state.showChinese = true;
  state.usersLoaded = false;
  state.csrf = null;
  state.selected = null;
  state.detailHydrationQueued.clear();
  displayCache.clear();
  state.searchToken++;
  state.lastSearchQuery = '';
  state.lastBrowseDestination = { href: '#/discover', label: 'Discover' };
  state.searchItems.clear();
  state.libraryLoaded = false;
  state.libraryAfter = null;
  state.airingLoaded = false;
  state.airingPreferences = null;
  trackingPrefsPromise = null;
  trackingPreferencesRevision++;
  trackingMutationTail = Promise.resolve();
  trackingSaving = false;
  byId('airing-view-mode').disabled = false;
  airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
  genreSelections.airing.clear();
  genreSelections.season.clear();
  state.seasonalRouteKey = null;
  state.routePage = null;
  state.nextBeforeId = { watching: null, history: null, preparing: null };
  state.requestHistoryExpanded = false;
  admin.resetReview();
  state.releaseSearch = false;
  state.detailLoad = false;
  state.titleChecks = false;
  state.acquisitionState = 'disabled';
  byId('service-notice').textContent =
    'Negev is in preview. Sign in to see acquisition status.';
  byId('request-list').replaceChildren();
  byId('preparing-list').replaceChildren();
  byId('more-preparations').hidden = true;
  byId('watch-list').replaceChildren();
  byId('review-list').replaceChildren();
  byId('main-nav').hidden = true;
  byId('mobile-nav').hidden = true;
  byId('more-review').hidden = true;
  byId('admin-review').hidden = true;
  byId('results').replaceChildren(element('p', 'Search by title to begin.', 'muted'));
  byId('detail').replaceChildren(element('p', 'Select a result to see its details.', 'muted'));
  byId('search-form').reset();
  byId('search-form').hidden = true;
  byId('invite-code').textContent = '';
  byId('invite-code').hidden = true;
  byId('identity').hidden = true;
  byId('browse-preferences').hidden = true;
  byId('adult-toggle').hidden = true;
  byId('chinese-toggle').hidden = true;
  byId('identity').open = false;
  byId('workspace').hidden = true;
  byId('session-loading').hidden = true;
  byId('auth').hidden = false;
}
// Fill the matching form from an invitation or reset link (once).
function applyPendingLinkCode() {
  const link = pendingLinkCode;
  if (!link) return;
  pendingLinkCode = null;
  if (link.kind === 'invite') {
    authTab(true);
    byId('register-form').elements.code.value = link.code;
    message('Invitation found. Choose a username and password to create your account.');
    byId('register-form').elements.username.focus();
  } else {
    byId('login-form').hidden = true;
    byId('register-form').hidden = true;
    const form = byId('reset-form');
    form.hidden = false;
    form.elements.code.value = link.code;
    message('Choose a new password for your account.');
    form.elements.password.focus();
  }
}
async function refreshSession() {
  const started = sessionResponses.current();
  try {
    const data = await api('/api/session');
    if (!sessionResponses.isCurrent(started)) return;
    showSession(data);
    loadRequests();
    if (data.user.role === 'admin') void loadOperationalReview();
    return true;
  } catch (error) {
    if (!sessionResponses.isCurrent(started)) return false;
    if ([401, 403].includes(error?.status)) {
      clearWorkspace();
      applyPendingLinkCode();
    } else {
      byId('session-loading-text').textContent =
        'Could not check your session.';
      byId('session-retry').hidden = false;
      byId('session-loading').hidden = false;
      message('Could not check your session. Retry the session check.', true);
    }
    return false;
  }
}
const requestsView = createRequestController({ api: (...args) => api(...args), byId, element, message, posterImage, preferredDisplayTitle, releaseDialog, requestResponses, restoreRoutePosition: (...args) => restoreRoutePosition(...args), sessionResponses, state, titleLabel });
const { expandedRequestDetails, loadRequestView, requestGroupRows, renderRequestStatus, requestItemPresentation, refreshRequestStatusAges, refreshExpandedHistory, loadRequests, loadPreparations, refreshVisibleRequests } = requestsView;











setInterval(refreshVisibleRequests, 60_000);
document.addEventListener('visibilitychange', refreshVisibleRequests);
function discoveryCard(item, note, badge, available = false) {
  const entry = { ...item, adult: item.adult ??
    state.searchItems.get(item.anidbId)?.adult };
  const card = markAdult(element('a', undefined, 'poster-card'), entry);
  card.href = titleRoute(item.anidbId);
  const frame = element('span', 'N', 'poster-frame poster-fallback');
  const poster = posterImage(item);
  poster.addEventListener('load', () => frame.classList.add('has-poster'));
  frame.append(poster);
  const copy = element('span', undefined, 'poster-copy');
  copy.append(titleLabel(item));if(note)copy.append(element('small',note));
  const coverage=available?catalogueAvailability({state:'in_library',regularCoverage:item.regularCoverage??item.libraryPresence?.regularCoverage},item.releaseStatus):null;
  if(badge){const label=element('span',coverage?.text??badge,`badge ${coverage?.state==='partial'?'partial':coverage?.state==='unknown'?'unknown':available?'ready':'unknown'}`);
    if(coverage?.specialText)label.append(element('span',coverage.specialText,'special-coverage '+coverage.specialState));copy.append(label);}
  if (item.rating) {
    const members = new Intl.NumberFormat('en', { notation: 'compact',
      maximumFractionDigits: 1 }).format(item.rating.members);
    const rating = element('small', item.rating.score === null
      ? `${members} members · Unrated`
      : `★ ${item.rating.score.toFixed(1)} · ${members} members`,
    'muted rating-line');
    rating.title = item.rating.source === 'anilist'
      ? `AniList average score · ${item.rating.members.toLocaleString()} members · checked ${new Date(item.rating.checkedMs).toLocaleDateString()}`
      : `MAL snapshot via AniMap · ${item.rating.votes.toLocaleString()} ratings · ${item.rating.members.toLocaleString()} members · checked ${new Date(item.rating.checkedMs).toLocaleDateString()}`;
    copy.append(rating);
  }
  if (item.adult) copy.append(element('span', '18+', 'badge partial'));
  card.append(frame, copy);
  state.searchItems.set(item.anidbId, entry);
  return card;
}
function publicPresenceBadge(presence,item={}) {
  const badge=catalogueAvailability(presence,item.releaseStatus);
  if(!badge)return document.createDocumentFragment();
  const label=element('span',badge.text,'presence '+badge.state);
  if(badge.specialText)label.append(element('span',badge.specialText,'special-coverage '+badge.specialState));return label;
}
const prefetchBudgets = { library: createCataloguePrefetchBudget(), discover: createCataloguePrefetchBudget(), airing: createCataloguePrefetchBudget() };
let libraryPageObserver = null;
function stopLibraryPageObserver() {
  libraryPageObserver?.disconnect();
  libraryPageObserver = null;
}
function appendLibraryPageMarker(list) {
  const session = sessionResponses.current();
  let epoch = libraryResponses.current();
  const route = location.hash;
  const current = () => sessionResponses.isCurrent(session) &&
    libraryResponses.isCurrent(epoch) && location.hash === route;
  const marker = element('div', 'Loading more titles as you scroll…',
    'library-page-marker muted');
  marker.setAttribute('role', 'status');
  list.append(marker);
  const continuation = { marker, showError() {
    marker.replaceChildren(element('p',
      'The next page could not be loaded. Titles already shown remain available.',
      'muted'));
    const retry = element('button', 'Retry loading more titles', 'text-link');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (retry.disabled || !current()) return;
      prefetchBudgets.library.consume(window.scrollY);
      retry.disabled = true;
      marker.replaceChildren(element('p', 'Loading more titles…', 'muted'));
      void loadLibrary(true, continuation);
      epoch = libraryResponses.current();
    });
    marker.append(retry);
  } };
  let started = false;
  const start = () => {
    if (started || !current()) return;
    started = true; observer.disconnect();
    if (libraryPageObserver === observer) libraryPageObserver = null;
    marker.textContent = 'Loading more titles…';
    void loadLibrary(true, continuation); epoch = libraryResponses.current();
  };
  const manual = element('button', 'Load more titles', 'text-link');
  manual.type = 'button'; manual.addEventListener('click', () => { prefetchBudgets.library.consume(window.scrollY); start(); }); marker.append(manual);
  const observer = observeCatalogueContinuation(marker, start, window.innerHeight,
    undefined, { budget: prefetchBudgets.library });
  libraryPageObserver = observer;
}
const browsePageObservers = { discover: null, airing: null };
function stopBrowsePageObserver(view) {
  browsePageObservers[view]?.observer.disconnect();
  browsePageObservers[view]?.marker.remove();
  browsePageObservers[view] = null;
}
function appendBrowsePageMarker(view, list, loadPage) {
  const session = sessionResponses.current();
  const responses = view === 'discover' ? seasonalResponses : airingSeasonResponses;
  let epoch = responses.current();
  const route = location.hash;
  const current = () => sessionResponses.isCurrent(session) &&
    responses.isCurrent(epoch) && location.hash === route;
  stopBrowsePageObserver(view);
  const marker = element('div', 'Loading more titles as you scroll…',
    'browse-page-marker muted');
  marker.setAttribute('role', 'status');
  list.after(marker);
  const continuation = { marker, showError() {
    marker.replaceChildren(element('p',
      'The next page could not be loaded. Titles already shown remain available.',
      'muted'));
    const retry = element('button', 'Retry loading more titles', 'text-link');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (retry.disabled || !current()) return;
      prefetchBudgets[view].consume(window.scrollY);
      retry.disabled = true;
      marker.replaceChildren(element('p', 'Loading more titles…', 'muted'));
      void loadPage(continuation);
      epoch = responses.current();
    });
    marker.append(retry);
  } };
  let started = false;
  const start = () => {
    if (started || !current()) return;
    started = true; observer.disconnect(); marker.textContent = 'Loading more titles…';
    void loadPage(continuation); epoch = responses.current();
  };
  const manual = element('button', 'Load more titles', 'text-link');
  manual.type = 'button'; manual.addEventListener('click', () => { prefetchBudgets[view].consume(window.scrollY); start(); }); marker.append(manual);
  const observer = observeCatalogueContinuation(marker, start, window.innerHeight,
    undefined, { budget: prefetchBudgets[view] });
  browsePageObservers[view] = { observer, marker };
}
async function loadLibrary(append = false, continuation = null) {
  if (!append) { stopLibraryPageObserver(); prefetchBudgets.library.reset(); }
  const route = location.hash;
  const session = sessionResponses.current();
  const epoch = libraryResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('library-list');
  const notice=byId('library-state');
  if (!append) {
    list.className = 'poster-grid';
    notice.textContent='Loading the library…';
    list.querySelector('.library-page-marker')?.remove();
    if(!list.querySelector('.poster-card'))list.replaceChildren();
    state.libraryAfter = null;
  }
  try {
    const suffix = append && state.libraryAfter !== null
      ? `?afterAnidbId=${state.libraryAfter}` : '';
    const page = await api(`/api/library${suffix}`, { catalogueCurrent: () => sessionResponses.isCurrent(session) && libraryResponses.isCurrent(epoch) && state.user?.id === userId && location.hash === route });
    if (!sessionResponses.isCurrent(session) ||
        !libraryResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (!append) list.replaceChildren();
    else continuation?.marker.remove();
    state.libraryLoaded = true;notice.replaceChildren();
    if (!append && page.items.length === 0) {
      list.append(element('p',
        'Nothing is confirmed available here yet. Try searching the catalogue.',
        'empty-state'));
    }
    for (const item of page.items) {
      list.append(trackedCard(discoveryCard(item,
        item.type||'',
        'In library', true), item));
    }
    state.libraryAfter = page.nextAfterAnidbId;
    if (state.libraryAfter !== null) appendLibraryPageMarker(list);
    restoreRoutePosition();
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !libraryResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (!append) {
      notice.replaceChildren(element('span', 'The library could not be refreshed. '));
      const retry=element('button','Retry','quiet');retry.type='button';retry.addEventListener('click',()=>loadLibrary());notice.append(retry);
    }
    else continuation?.showError();
  }
}
function seasonChoice(route) {
  if (route.year !== undefined && route.season) return { year: route.year,
    season: route.season, after: route.after ?? 0,
    kind: route.kind ?? 'all', tag: route.tag ?? '', sort: route.sort ?? 'newest' };
  return { year: 0, season: 'ALL', after: 0, kind: 'all', tag: '', sort: 'newest' };
}
for (let year = new Date().getUTCFullYear() + 2; year >= 1900; year--) {
  const option = element('option', String(year));
  option.value = String(year);
  byId('season-year').append(option);
  byId('airing-year').append(option.cloneNode(true));
}
function renderGenres(prefix, availableTags, selected) {
  const choices = byId(`${prefix}-tags`);
  const search = byId(`${prefix}-tag-search`);
  const more = byId(`${prefix}-tag-more`);
  let expanded = false;
  genreSelections[prefix] = new Set(selected ? selected.split(',') : []);
  const featured = ['action', 'adventure', 'comedy', 'drama', 'fantasy',
    'romance', 'sci-fi', 'slice of life', 'supernatural', 'sports', 'horror',
    'mystery', 'psychological', 'mecha', 'music', 'historical', 'magic'];
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const matching = query
      ? availableTags.filter((tag) => tag.includes(query))
      : [...new Set([...genreSelections[prefix],
        ...featured.filter((tag) => availableTags.includes(tag)), ...availableTags])];
    const visible = expanded ? matching : matching.slice(0, 40);
    const options = document.createDocumentFragment();
    for (const tag of visible) {
      const label = element('label', undefined, 'genre-option');
      const box = element('input');
      box.type = 'checkbox';
      box.value = tag;
      box.checked = genreSelections[prefix].has(tag);
      box.addEventListener('change', () => {
        if (box.checked) {
          if (genreSelections[prefix].size >= 5) box.checked = false;
          else genreSelections[prefix].add(tag);
        } else genreSelections[prefix].delete(tag);
        byId(`${prefix}-form`).querySelector('.genre-picker summary').textContent =
          `Genres & themes · ${genreSelections[prefix].size || 'All'}`;
        // Several quick clicks become one read (the browse API allows 12 a minute).
        scheduleFilterApply(prefix, 1_200);
      });
      label.append(box, document.createTextNode(tag));
      options.append(label);
    }
    choices.replaceChildren(options);
    more.hidden = expanded || matching.length <= 40;
    more.textContent = `Show all ${matching.length.toLocaleString()} matches`;
    byId(`${prefix}-tag-count`).textContent = matching.length > visible.length
      ? `Showing ${visible.length} of ${matching.length} matches. Search or show all; select up to five.`
      : `${matching.length} matching genres and themes. Select up to five.`;
    byId(`${prefix}-form`).querySelector('.genre-picker summary').textContent =
      `Genres & themes · ${genreSelections[prefix].size || 'All'}`;
  };
  search.value = '';
  search.oninput = () => { expanded = false; render(); };
  search.onkeydown = (event) => { if (event.key === 'Enter') event.preventDefault(); };
  more.onclick = () => { expanded = true; render(); };
  render();
}
function catalogueReadError(notice, list) {
  notice.className = 'catalogue-error';
  const copy = element('span');
  copy.append(element('strong', 'The catalogue could not be refreshed'),
    element('p', list.querySelector('.poster-card') ? 'Your previous results are still shown.' : 'Try again to load titles.', 'muted'));
  const retry = element('button', 'Retry', 'primary');
  retry.addEventListener('click', () => byId('season-form').requestSubmit());
  notice.replaceChildren(copy, retry);
}
async function loadSeasonal({ year, season, after, kind, tag, sort = 'newest' },
  scoreRefresh = 0, continuation = null) {
  const append = continuation !== null;
  if (!append) { stopBrowsePageObserver('discover'); prefetchBudgets.discover.reset(); }
  const route = location.hash;
  const session = sessionResponses.current();
  const epoch = seasonalResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('season-list');
  const notice = byId('season-state');
  if (!append) {
    byId('season-year').value = String(year);
    byId('season-name').value = season;
    byId('season-kind').value = kind;
    byId('season-sort').value = sort;
    notice.textContent = year === 0 && season === 'ALL'
      ? 'Loading the anime catalogue…'
      : `Loading ${season === 'ALL' ? 'all seasons' : season.toLowerCase()} ${year || 'across all years'}…`;
    notice.className = 'muted';
  }
  try {
    const params = new URLSearchParams({ year: String(year), season });
    if (after) params.set('after', String(after));
    if (kind !== 'all') params.set('kind', kind);
    if (tag) params.set('tag', tag);
    if (sort !== 'newest') params.set('sort', sort);
    const page = await api(`/api/seasons?${params}`, { catalogueCurrent: () => sessionResponses.isCurrent(session) && seasonalResponses.isCurrent(epoch) && state.user?.id === userId && location.hash === route });
    if (!sessionResponses.isCurrent(session) ||
        !seasonalResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (page.state === 'unavailable') {
      if (append) continuation.showError();
      else catalogueReadError(notice, list);
      return;
    }
    if (append) stopBrowsePageObserver('discover');
    else { list.replaceChildren(); renderGenres('season', page.availableTags ?? [], tag); }
    if (!append) notice.textContent = page.state === 'stale'
      ? `Showing a saved catalogue from ${page.sourceDate}; source refresh is unavailable.`
      : page.state === 'partial'
        ? `Catalogue updated ${page.sourceDate}. Some title details could not be checked; try again later.`
        : page.orderState === 'anilist_score'
          ? `Highest rated · AniList. Unranked titles follow.`
          : page.orderState === 'anilist_popular'
          ? `Most popular · AniList. Unranked titles follow.`
          : page.orderState === 'anilist_stale'
          ? `Showing the last saved AniList ranking; a fresh ranking is unavailable.`
          : page.orderState === 'anilist_unavailable'
          ? `AniList ranking is unavailable; showing catalogue order.`
          : page.orderState === 'score_partial'
          ? `Catalogue updated ${page.sourceDate}. Known ${sort === 'score_desc' ? 'scores' : 'member counts'} first; titles without a rating follow while ratings fill in.`
          : page.orderState === 'score_loading'
            ? `Catalogue updated ${page.sourceDate}. Ratings are loading; showing catalogue order for now.`
            : page.orderState === 'score_unavailable'
              ? `Catalogue updated ${page.sourceDate}. Ratings are unavailable; showing catalogue order.`
            : page.scorePending ? 'Ratings updating…' : '';
    if (!append) {
      const active = byId('discover-active-filters');
      if (active) {
        active.replaceChildren();
        const labels = [year || null, season === 'ALL' ? null : season[0] + season.slice(1).toLowerCase(), kind === 'all' ? null : kind === 'movies' ? 'Movies' : 'Series', ...tag.split(',').filter(Boolean)].filter(Boolean);
        for (const label of labels) active.append(element('span', String(label), 'filter-chip'));
        if (labels.length) { const clear = element('a', 'Clear filters', 'text-link'); clear.href = seasonRoute(0, 'ALL', 0, { sort }); active.append(clear); }
        active.hidden = labels.length === 0;
      }
    }
    if (page.items.length === 0 && page.nextAfter === null) list.append(element('p',
      'No verified titles on this page. Search may find titles missing from the season map.',
      'empty-state'));
    for (const item of page.items) {
      const button = markAdult(element('button', undefined, 'poster-card'), item);
      button.type = 'button';
      const frame = element('span', undefined, 'poster-frame');
      frame.append(posterImage(item));
      const copy = element('span', undefined, 'poster-copy');
      copy.append(titleLabel(item),
        element('small', item.type || 'Anime'),
        publicPresenceBadge(item.libraryPresence,item));
      if (item.rating) {
        const members = new Intl.NumberFormat('en', { notation: 'compact',
          maximumFractionDigits: 1 }).format(item.rating.members);
        const rating = element('small', item.rating.score === null
          ? `${members} members · Unrated`
          : `★ ${item.rating.score.toFixed(1)} · ${members} members`,
        'muted rating-line');
        rating.title = item.rating.source === 'anilist'
          ? `AniList average score · ${item.rating.members.toLocaleString()} members`
          : `MAL snapshot via AniMap · ${item.rating.votes.toLocaleString()} ratings`;
        copy.append(rating);
      }
      if (item.adult) copy.append(element('span', '18+', 'badge partial'));
      button.append(frame, copy);
      button.addEventListener('click', () => {
        state.searchItems.set(item.anidbId, item);
        location.hash = titleRoute(item.anidbId);
      });
      list.append(trackedCard(button, item));
    }
    if (page.nextAfter !== null) appendBrowsePageMarker('discover', list,
      (retry) => loadSeasonal({ year, season, after: page.nextAfter,
        kind, tag, sort }, 0, retry));
    restoreRoutePosition();
    if (!append && page.scorePending && scoreRefresh < 2) {
      setTimeout(() => {
        if (sessionResponses.isCurrent(session) &&
            seasonalResponses.isCurrent(epoch) &&
            location.hash === seasonRoute(year, season, after,
              { kind, tag, sort })) {
          void loadSeasonal({ year, season, after, kind, tag, sort },
            scoreRefresh + 1);
        }
      }, scoreRefresh === 0 ? 10_000 : 20_000);
    }
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !seasonalResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (append) continuation.showError();
    else catalogueReadError(notice, list);
  }
}
byId('season-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const year = Number(byId('season-year').value);
  const season = byId('season-name').value;
  const kind = byId('season-kind').value;
  const sort = byId('season-sort').value;
  const tag = [...genreSelections.season].join(',');
  if (!Number.isSafeInteger(year) || year !== 0 && (year < 1900 || year > 2100)) return;
  const route = seasonRoute(year, season, 0, { kind, tag, sort });
  if (location.hash === route) void loadSeasonal({ year, season,
    after: 0, kind, tag, sort });
  else {
    // A retry can move from the short Discover URL to an equivalent filter
    // URL. It still needs one fresh read when the previous read failed.
    state.seasonalRouteKey = null;
    location.hash = route;
  }
});
byId('season-sort').addEventListener('change', () =>
  byId('season-form').requestSubmit());
byId('discover-filters-toggle')?.addEventListener('click', event => {
  if (parseConsumerRoute(location.hash).query?.length >= 2) location.hash = '#/discover';
  const expanded = byId('season-form').classList.toggle('filters-expanded');
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
  if(!expanded)for(const details of byId(event.currentTarget.id==='airing-filters-toggle'?'airing-form':'season-form').querySelectorAll('details[open]'))details.open=false;
});
byId('airing-filters-toggle').addEventListener('click', event => {
  const expanded = byId('airing-form').classList.toggle('filters-expanded');
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
});
function renderAiringFilterChips() {
  const active=byId('airing-active-filters');active.replaceChildren();
  const {year,season,kind,tag}=airingFilters;
  const labels=[year||null,season==='ALL'?null:season[0]+season.slice(1).toLowerCase(),kind==='all'?null:kind==='movies'?'Movies':'Series',...tag.split(',').filter(Boolean)].filter(Boolean);
  for(const label of labels)active.append(element('span',String(label),'filter-chip'));
  active.hidden=labels.length===0;
  if(labels.length){const clear=element('button','Clear filters','text-link');clear.type='button';clear.addEventListener('click',()=>{
    airingFilters={...airingFilters,year:0,season:'ALL',kind:'all',tag:''};
    void loadCurrentAiring(sessionResponses.current(),airingSeasonResponses.invalidate(),state.user?.id);
  });active.append(clear);}
}
let airingBrowseAfter = 0;
async function loadCurrentAiring(session, epoch, userId, after = 0,
  continuation = null) {
  const route = location.hash;
  const list = byId('airing-season-list');
  const notice = byId('airing-season-state');
  if (after === 0) {
    airingBrowseAfter = 0; prefetchBudgets.airing.reset();
    stopBrowsePageObserver('airing');
    notice.textContent = 'Loading ongoing titles…';
    list.replaceChildren();
  }
  const { year, season, kind, tag, sort } = airingFilters;
  byId('airing-year').value = String(year);
  byId('airing-season').value = season;
  byId('airing-kind').value = kind;
  byId('airing-sort').value = sort;
  renderAiringFilterChips();
  const params = new URLSearchParams({ year: String(year), season,
    status: 'ongoing', sort });
  if (kind !== 'all') params.set('kind', kind);
  if (tag) params.set('tag', tag);
  if (after) params.set('after', String(after));
  try {
    const page = await api(`/api/seasons?${params}`, { catalogueCurrent: () => sessionResponses.isCurrent(session) && airingSeasonResponses.isCurrent(epoch) && state.user?.id === userId && location.hash === route });
    if (!sessionResponses.isCurrent(session) ||
        !airingSeasonResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (page.state === 'unavailable') {
      if (continuation) continuation.showError();
      else notice.textContent = 'The ongoing-title catalogue is unavailable right now.';
      return;
    }
    if (continuation) stopBrowsePageObserver('airing');
    airingBrowseAfter = after;
    if (after === 0) renderGenres('airing', page.availableTags ?? [], tag);
    if (after === 0) notice.textContent = page.orderState === 'anilist_score'
      ? 'Highest rated ongoing anime first · AniList ranking. Other titles follow.'
      : page.orderState === 'anilist_popular'
      ? 'Most popular ongoing anime first · AniList ranking. Other titles follow.'
      : page.orderState === 'anilist_stale'
      ? 'Showing the last saved AniList ranking; a fresh ranking is unavailable.'
      : page.orderState === 'anilist_unavailable'
      ? 'AniList ranking is unavailable; showing ongoing titles in catalogue order.'
      : page.orderState === 'score_loading'
      ? 'Ratings are loading in the background. Showing season order until ranking is ready; this page refreshes automatically.'
      : page.orderState === 'score_unavailable'
      ? 'Ratings are unavailable. Showing season order.'
      : page.orderState === 'score'
      ? 'Highest rated first · MAL score snapshot via AniMap. Unrated titles appear last.'
      : page.orderState === 'popularity'
      ? 'Most popular first · MAL member snapshot via AniMap.'
      : page.orderState === 'fallback'
      ? 'This week’s episode dates are unavailable; showing newest ongoing titles first.'
      : page.state === 'stale'
      ? 'Showing a saved ongoing-title list; release status may have changed.'
      : 'Titles with episodes this week appear first, followed by other ongoing titles.';
    for (const item of page.items ?? []) {
      const count = item.libraryPresence?.verifiedEpisodeCount ?? 0;
      const available = item.libraryPresence?.state === 'in_library' && count > 0;
      if (state.airingPreferences?.mode === 'library' && !available) continue;
      const card = discoveryCard(item, item.type || 'Anime', available
        ? 'In library'
        : null, available);
      list.append(trackedCard(card, item));
    }
    if (after === 0 && page.orderState === 'score_loading') {
      setTimeout(() => {
        if (sessionResponses.isCurrent(session) &&
            airingSeasonResponses.isCurrent(epoch) &&
            state.user?.id === userId && state.routePage === 'airing' &&
            airingBrowseAfter === 0) {
          void loadCurrentAiring(session, epoch, userId);
        }
      }, 30_000);
    }
    if (page.nextAfter !== null && page.nextAfter !== undefined) {
      appendBrowsePageMarker('airing', list, (retry) =>
        loadCurrentAiring(session, epoch, userId, page.nextAfter, retry));
    } else if (!list.childElementCount) {
      list.append(element('p', 'No ongoing titles match these filters.',
        'empty-state'));
    }
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !airingSeasonResponses.isCurrent(epoch) || state.user?.id !== userId ||
        location.hash !== route) return;
    if (continuation) continuation.showError();
    else notice.textContent = 'The ongoing-title list is unavailable. This week’s schedule is separate.';
  }
}
byId('airing-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const year = Number(byId('airing-year').value);
  const season = byId('airing-season').value;
  const kind = byId('airing-kind').value;
  const sort = byId('airing-sort').value;
  const tag = [...genreSelections.airing].join(',');
  if (!Number.isSafeInteger(year) || year !== 0 && (year < 1900 || year > 2100) ||
      !['ALL', 'WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(season) ||
      !['all', 'series', 'movies'].includes(kind) ||
      !['newest', 'oldest', 'title_asc', 'title_desc', 'next_episode',
        'score_desc', 'popular_desc'].includes(sort)) return;
  airingFilters = { year, season, kind, tag, sort };
  const epoch = airingSeasonResponses.invalidate();
  void loadCurrentAiring(sessionResponses.current(), epoch, state.user?.id);
});
byId('airing-sort').addEventListener('change', () =>
  byId('airing-form').requestSubmit());
// Filters apply as soon as they change; there is no Apply button.
const filterApplyTimers = {};
function scheduleFilterApply(prefix, delay = 0) {
  clearTimeout(filterApplyTimers[prefix]);
  filterApplyTimers[prefix] = setTimeout(() => {
    delete filterApplyTimers[prefix];
    // Leaving the page drops a pending change instead of navigating back.
    const form = byId(`${prefix}-form`);
    if (form.closest('.page-view')?.hidden) return;
    form.requestSubmit();
  }, delay);
}
window.addEventListener('hashchange', () => {
  for (const prefix of Object.keys(filterApplyTimers)) {
    clearTimeout(filterApplyTimers[prefix]);
    delete filterApplyTimers[prefix];
  }
});
for (const [prefix, ids] of [['season', ['season-year', 'season-name', 'season-kind']],
  ['airing', ['airing-year', 'airing-season', 'airing-kind']]]) {
  for (const id of ids) byId(id).addEventListener('change', () => scheduleFilterApply(prefix));
}
async function loadAiring() {
  stopBrowsePageObserver('airing');
  const session = sessionResponses.current();
  const epoch = airingResponses.invalidate();
  const seasonEpoch = airingSeasonResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('airing-list');
  const notice = byId('airing-state');
  try {
    state.airingPreferences = await ensureTrackingPreferences();
  } catch {
    if (sessionResponses.isCurrent(session) && airingResponses.isCurrent(epoch)) {
      byId('airing-season-state').textContent = 'Airing preferences are unavailable. Try again.';
    }
    return;
  }
  if (!sessionResponses.isCurrent(session) ||
      !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
  byId('airing-view-mode').value = state.airingPreferences.mode;
  renderTrackedTitles();
  byId('airing-mode-help').textContent = state.airingPreferences.mode === 'library'
    ? 'Shows with verified playable items in Negev’s Library.'
    : state.airingPreferences.mode === 'custom'
    ? 'Your selected shows. Switch to All airing anime to track more.'
    : 'All ongoing shows. Use Track this title to build a custom list.';
  if (airingSeasonResponses.isCurrent(seasonEpoch)) {
    void loadCurrentAiring(session, seasonEpoch, userId);
  }
  notice.textContent = '';
  list.replaceChildren(element('p', 'Loading this week’s schedule…', 'muted'));
  try {
    const schedule = await api('/api/airing');
    if (!sessionResponses.isCurrent(session) ||
        !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    state.airingLoaded = true;
    notice.textContent = schedule.state === 'stale'
      ? `AniDB schedule temporarily unavailable. Showing a saved ${schedule.week} snapshot; check dates before relying on it.`
      : `AniDB schedule · ${schedule.week}. Availability is checked separately.`;
    list.replaceChildren();
    if (schedule.items.length === 0) {
      list.append(element('p',
        'No regular episodes are listed for this week. This does not mean no series is airing.',
        'empty-state'));
    }
    for (const item of schedule.items) {
      const button = markAdult(element('button', undefined, 'result'), item);
      button.type = 'button';
      const art = element('span', 'N', 'poster-fallback');
      const poster = posterImage(item);
      poster.addEventListener('load', () => art.classList.add('has-poster'));
      art.append(poster);
      const copy = element('span', undefined, 'result-copy');
      const available = item.libraryPresence?.state === 'in_library' &&
        item.libraryPresence.verifiedEpisodeCount > 0;
      if (state.airingPreferences?.mode === 'library' && !available) continue;
      copy.append(titleLabel(item),
        element('small', `Episode ${item.episodeNumber} · scheduled ${item.scheduledDate}`),
        element('span', available
          ? '✓ Show has playable items' : 'Scheduled episode',
        `presence ${available ? 'available' : 'unknown'}`));
      if (item.adult) copy.append(element('span', '18+', 'badge partial'));
      button.append(art, copy);
      button.addEventListener('click', () => {
        state.searchItems.set(item.anidbId, item);
        location.hash = titleRoute(item.anidbId);
      });
      list.append(trackedCard(button, item));
    }
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    notice.textContent = 'This week’s AniDB schedule is unavailable right now.';
    list.replaceChildren(element('p',
      'Try this page again later. Your existing requests and watches are unaffected.',
      'empty-state'));
  }
}
byId('airing-view-mode').addEventListener('change', async (event) => {
  const select = event.currentTarget;
  const session = sessionResponses.current();
  const previous = state.airingPreferences;
  if (!previous) return;
  const mode = select.value;
  select.disabled = true;
  try {
    if (!await changeTrackingPreferences({ action: 'mode', mode })) return;
    renderTrackedTitles();
    updateTrackControls();
    state.airingLoaded = false;
    void loadAiring();
  } catch (error) {
    if (!sessionResponses.isCurrent(session)) return;
    select.value = previous.mode;
    byId('airing-season-state').textContent = error.message;
  } finally { if (sessionResponses.isCurrent(session)) select.disabled = false; }
});
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('refresh-library').addEventListener('click', () => {
  if (parseConsumerRoute(location.hash).query) {
    location.hash = '#/library';
    return;
  }
  void loadLibrary();
});
byId('more-requests').addEventListener('click', () => { void loadRequestView('history', true); });
byId('more-preparations').addEventListener('click', () => { void loadPreparations(false, true); });
byId('more-watches').addEventListener('click', () => { void loadRequestView('watching', true); });
// Buttons offered for a parked review item. Retry re-runs every normal check;
// release only applies to a download that never started.
const admin = createAdminController({ element, message, titleLabel, api: (...args) => api(...args), applyAdultVisibility: (...args) => applyAdultVisibility(...args), byId, readAdultPreference: (...args) => readAdultPreference(...args), reviewResponses, sessionResponses, state });
const { reviewActionsFor, loadOperationalReview, showShareLink, createInviteLink, loadInvites, loadUsers } = admin;

byId('refresh-review').addEventListener('click', () => { void loadOperationalReview(); });
byId('more-review').addEventListener('click', () => { void loadOperationalReview(true); });
function authTab(register) {
  byId('login-form').hidden = register;
  byId('register-form').hidden = !register;
  const reset = byId('reset-form');
  if (reset) reset.hidden = true;
  byId('login-tab').classList.toggle('selected', !register);
  byId('register-tab').classList.toggle('selected', register);
  message('');
}
byId('login-tab').addEventListener('click', () => authTab(false));
byId('register-tab').addEventListener('click', () => authTab(true));
byId('session-retry').addEventListener('click', () => {
  byId('session-retry').hidden = true;
  byId('session-loading-text').textContent = 'Checking your session…';
  message('');
  void refreshSession();
});
byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({
      username: fields.get('username'), password: fields.get('password'),
    }) });
    sessionResponses.invalidate();
    form.reset();
    if (await refreshSession()) message('Signed in. Search for a show or film.');
  } catch (error) { message(error.message, true); }
});
byId('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({
      code: fields.get('code'), username: fields.get('username'),
      password: fields.get('password'),
    }) });
    form.reset();
    authTab(false);
    message('Account created. Sign in to continue.');
  } catch (error) {
    message(error.message, true);
    if (['code','username','password'].includes(error.field)) form.elements.namedItem(error.field)?.focus();
  }
});
byId('signout').addEventListener('click', () => { void signOut(false); });
byId('signout-everywhere').addEventListener('click', () => { void signOut(true); });
async function signOut(everywhere) {
  const session = sessionResponses.current();
  try {
    await api('/api/logout', { method: 'POST',
      body: everywhere ? JSON.stringify({ everywhere: true }) : '{}' });
  } catch (error) {
    if (error.status === 401) { if (!state.user) message('Signed out.'); return; }
    if (sessionResponses.isCurrent(session)) message(error.message, true);
    return;
  }
  if (!sessionResponses.isCurrent(session)) return;
  clearWorkspace();
  message(everywhere ? 'Signed out on all devices.' : 'Signed out.');
  if (pendingLinkCode) applyPendingLinkCode();
}
byId('adult-toggle').addEventListener('click', () => {
  if (!state.user || state.user.adultAllowed === false) return;
  state.showAdult = !state.showAdult;
  try { localStorage.setItem(adultPreferenceKey(state.user.id),
    state.showAdult ? 'on' : 'off'); } catch { /* Choice still applies this session. */ }
  applyAdultVisibility();
  void classifySearchCards(state.searchToken);
  if (parseConsumerRoute(location.hash).page === 'title' && state.selected) {
    const item = state.searchItems.get(state.selected) ??
      { anidbId: state.selected, title: `Anime ${state.selected}` };
    void showDetail(item);
  }
});
byId('chinese-toggle').addEventListener('click', () => {
  if (!state.user) return;
  state.showChinese = !state.showChinese;
  try { localStorage.setItem(chinesePreferenceKey(state.user.id),
    state.showChinese ? 'on' : 'off'); }
  catch { /* Choice still applies this session. */ }
  applyAdultVisibility();
  void classifySearchCards(state.searchToken);
});
byId('english-title-toggle').addEventListener('click', () => {
  if (!state.user) return;
  state.preferEnglish = !state.preferEnglish;
  try { localStorage.setItem(englishTitlePreferenceKey(state.user.id),
    state.preferEnglish ? 'on' : 'off'); } catch { /* Applies for this session. */ }
  applyTitlePreference();
});
async function classifySearchCards(searchToken) {
  const pass = ++classificationToken;
  if (state.showAdult || !state.user) return;
  const userId = state.user.id;
  const session = sessionResponses.current();
  const route = location.hash;
  const current = () => pass === classificationToken && !state.showAdult && state.searchToken === searchToken &&
    state.user?.id === userId && sessionResponses.isCurrent(session) && location.hash === route;
  const ids = [...document.querySelectorAll('#results [data-anidb-id], #library-search-results [data-anidb-id]')]
    .filter((node) => node.dataset.adult === 'unknown' &&
      !hideChineseProduction(state.showChinese, node.dataset.chineseProduction === 'true'))
    .map((node) => Number(node.dataset.anidbId));
  await adultSearchVerifier.verify(ids, (id, adult) => {
    if (!current()) return;
    const item = state.searchItems.get(id);
    if (item) state.searchItems.set(id, { ...item, adult });
    for (const node of document.querySelectorAll('#results [data-anidb-id], #library-search-results [data-anidb-id]')) {
      if (Number(node.dataset.anidbId) === id) {
        node.dataset.adult = String(adult);
        if (adult && !node.querySelector('.adult-label')) {
          node.querySelector('.result-copy')?.append(
            element('span', '18+', 'badge partial adult-label'));
        }
      }
    }
    applyAdultVisibility();
  }, { current });
}
// Shows a one-time link with a Copy button. The link is only shown here; the
// server keeps just a digest, so it cannot be displayed again later.
// `session` is sessionResponses.current() from before the request: a link
// that arrives after sign-out (or an account switch) is never shown.



byId('invite').addEventListener('click', () => { void createInviteLink(); });
byId('admin-create-invite').addEventListener('click', () => { void createInviteLink(); });
byId('reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  try {
    const result = await api('/api/password-reset', { method: 'POST', body: JSON.stringify({
      code: fields.get('code'), password: fields.get('password') }) });
    form.reset();
    authTab(false);
    byId('login-form').elements.username.value = result.username;
    message('Password changed. Sign in with your new password.');
    byId('login-form').elements.password.focus();
  } catch (error) { message(error.message, true); }
});


byId('refresh-invites').addEventListener('click', () => { void loadInvites(); });

byId('refresh-users').addEventListener('click', () => { void loadUsers(); });
function submitInlineSearch(inputId, destination) {
  const input = byId(inputId);
  const query = input.value.trim();
  if (query.length < 2) {
    input.focus();
    return;
  }
  byId('query').value = query;
  if (destination === 'discover' && parseConsumerRoute(location.hash).page === 'airing') {
    location.hash = searchRoute(query);
  }
  byId('search-form').requestSubmit();
}

for (const [inputId, buttonId, destination] of [
  ['discover-query', 'discover-search-button', 'discover'],
  ['airing-query', 'airing-search-button', 'discover'],
  ['library-query', 'library-search-button', 'library'],
]) {
  const submit = () => submitInlineSearch(inputId, destination);
  byId(buttonId).addEventListener('click', submit);
  byId(inputId).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  });
}

byId('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = byId('query').value.trim();
  if (query.length < 2) return;
  const inLibrary = parseConsumerRoute(location.hash).page === 'library';
  state.lastSearchQuery = `${inLibrary ? 'library' : 'discover'}:${query}`;
  const route = inLibrary ? librarySearchRoute(query) : searchRoute(query);
  if (location.hash !== route) location.hash = route;
  const token = ++state.searchToken;
  const results = byId(inLibrary ? 'library-search-results' : 'results');
  const preserveResults = results.dataset.query === query && results.dataset.complete === 'true';
  results.dataset.query = query;
  results.dataset.complete = 'false';
  byId(inLibrary ? 'library-search-section' : 'search-results-section').hidden = false;
  if (inLibrary) {
    byId('library-browse').hidden = true;
    byId('search-all-catalogue').href = searchRoute(query);
  } else byId('search-verified-library').href = librarySearchRoute(query);
  if (!preserveResults) results.replaceChildren(element('p', 'Searching…', 'muted'));
  const appendItems = (items) => {
    for (const item of items) {
      const known = state.searchItems.get(item.anidbId);
      const entry = { ...item, adult: item.adult ?? known?.adult };
      state.searchItems.set(item.anidbId, entry);
      const button = markAdult(element('button', undefined, 'result'), entry,
        { hideUnknown: true });
      button.type = 'button';
      const tile = element('span', 'N', 'poster-fallback');
      tile.setAttribute('aria-hidden', 'true');
      const poster = posterImage(item);
      poster.addEventListener('load', () => tile.classList.add('has-poster'));
      tile.append(poster);
      const copy = element('span', undefined, 'result-copy');
      copy.append(titleLabel(item),
        element('small', `AniDB ${item.anidbId}`));
      const presence = inLibrary ? item.verifiedLibraryPresence : item.libraryPresence;
      copy.append(inLibrary && presence?.state !== 'in_library'
        ? element('span', 'Not found in Negev’s verified library', 'presence unknown')
        : publicPresenceBadge(presence,item));
      if (entry.adult === true) copy.append(
        element('span', '18+', 'badge partial adult-label'));
      button.append(tile, copy);
      button.addEventListener('click', () => { location.hash = titleRoute(item.anidbId); });
      results.append(trackedCard(button, entry, { hideUnknown: true }));
    }
    void classifySearchCards(token);
  };
  try {
    const data = await api(`/api/catalogue/search?q=${encodeURIComponent(query)}`);
    if (token !== state.searchToken) return;
    const pager = createSearchPager(data);
    results.replaceChildren();
    if (data.catalogueStale) results.append(element('p',
      'AniDB title list may be out of date. Check the title details before requesting.', 'muted'));
    if (data.catalogueCacheWriteFailed) results.append(element('p',
      'The title list could not be saved. Some titles may be missing after a restart if AniDB is offline.', 'muted'));
    if (data.items.length === 0) results.append(element('p', pager.nextPage === null
      ? 'No matching anime titles found. Try another name or browse the catalogue.'
      : 'The first results are hidden for your account. Show more to keep looking.', 'muted'));
    appendItems(data.items);
    results.dataset.complete = 'true';
    restoreRoutePosition();
    const addMore = () => {
      if (pager.nextPage === null) return;
      const button = element('button', 'Show more results');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const page = await api(`/api/catalogue/search?q=${encodeURIComponent(query)}&page=${pager.nextPage}`);
          if (token !== state.searchToken) return;
          const appended = pager.append(page);
          if (appended.state !== 'appended') {
            button.textContent = 'Results changed. Search again.';
            return;
          }
          button.remove();
          appendItems(appended.items);
          restoreRoutePosition();
          addMore();
        } catch {
          if (token === state.searchToken) {
            button.disabled = false;
            message('More results are unavailable right now.', true);
          }
        }
      });
      results.append(button);
    };
    addMore();
    message(`${data.total} catalogue result${data.total === 1 ? '' : 's'}.`);
  } catch (error) {
    if (token !== state.searchToken) return;
    if (preserveResults) results.prepend(element('p',
      'Could not refresh these saved results. Search again to retry.', 'muted'));
    else results.replaceChildren(element('p', 'Search is unavailable right now.', 'muted'));
    message(error.message, true);
  }
});
function pendingTitleAction(item) {
  if (!state.user || item.adult === true &&
      (!state.showAdult || state.user.adultAllowed !== true)) return null;
  const action = element('section', undefined, 'request-action');
  action.dataset.pending = 'true';
  const button = element('button', 'Request if missing', 'primary');
  const status = element('p', '', 'muted request-feedback');
  status.setAttribute('role', 'status');
  const viewRequest = element('a', 'View in My Requests →',
    'text-link request-receipt-link');
  viewRequest.href = '#/requests';
  viewRequest.hidden = true;
  const review = element('div', undefined, 'request-review');
  review.hidden = true;
  review.append(element('strong', 'Review your request'));
  review.append(element('p', `${item.title} · Negev will identify the film or episodes and check the library first`));
  review.append(element('p',
    'You can cancel the saved request until Negev starts processing a release. Cancellation does not remove files.',
    'muted'));
  const cancelReview = element('button', 'Cancel', 'quiet');
  cancelReview.type = 'button';
  cancelReview.addEventListener('click', () => {
    action.dataset.reviewing = 'false';
    review.hidden = true;
    button.textContent = pendingTitleLabel(action.dataset.kind);
    status.textContent = '';
  });
  review.append(cancelReview);
  action.append(review, button, status, viewRequest);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (action.dataset.reviewing !== 'true') {
      action.dataset.reviewing = 'true';
      review.hidden = false;
      button.textContent = 'Confirm request';
      status.textContent = 'Negev will check the episode list and Plex before any download.';
      return;
    }
    action.dataset.saving = 'true';
    button.disabled = true;
    button.textContent = 'Saving request…';
    status.textContent = 'Saving your request…';
    const scope = { userId: state.user.id, anidbId: item.anidbId };
    try {
      const saved = await api('/api/requests', { method: 'POST',
        body: JSON.stringify({ anidbId: item.anidbId, scope: 'installment',
          requestKey: requestKeys.pending(scope) }) });
      requestKeys.saved(scope);
      refreshTrackingAfterRequest();
      action.dataset.saving = 'false';
      action.dataset.saved = 'true';
      action.dataset.reviewing = 'false';
      review.hidden = true;
      button.disabled = true;
      button.textContent = saved.reason === 'already_monitored'
        ? 'Future episodes already monitored' : 'Requested';
      status.textContent = savedRequestMessage(saved);
      if (Number.isSafeInteger(saved.requestId) && saved.requestId > 0) {
        viewRequest.href = requestRoute(saved.requestId);
      }
      viewRequest.hidden = false;
      message(saved.reason === 'already_monitored'
        ? 'Future episodes are already monitored. View the existing request under My Requests.'
        : 'Request saved. Follow it under My Requests.');
      loadRequests();
    } catch (error) {
      action.dataset.saving = 'false';
      button.disabled = false;
      button.textContent = 'Confirm request';
      status.textContent = requestFailureMessage(error);
      message(status.textContent, true);
    }
  });
  return action;
}
function pendingTitleLabel(kind) {
  return kind === 'movie' ? 'Request film' :
    kind === 'series' ? 'Request series' : 'Request if missing';
}
function setPendingTitleKind(action, item, kind) {
  if (!action || !['movie', 'series'].includes(kind)) return;
  action.dataset.kind = kind;
  const summary = action.querySelector('.request-review p');
  if (summary) summary.textContent = kind === 'movie'
    ? `${item.title} · Negev will identify the film entry and check the library first`
    : `${item.title} · Negev will identify the episodes and check the library first`;
  if (action.dataset.reviewing !== 'true' && action.dataset.saving !== 'true' &&
      action.dataset.saved !== 'true') {
    action.querySelector('.primary').textContent = pendingTitleLabel(kind);
  }
}
// Whole-title Plex check, for titles imported outside Negev (e.g. manually
// through Shoko). Shown only when the server enables NEGEV_TITLE_CHECK.
function titleCheckSummary(anidbId, isCurrent) {
  const url = `/api/catalogue/${anidbId}/title-check`;
  const checkTitle = element('button', 'Check whole title in Plex');
  checkTitle.type = 'button';
  const progress = element('p', '', 'muted');
  progress.setAttribute('aria-live', 'polite');
  let pollTimer;
  let progressEpoch = 0;
  const showProgress = async () => {
    if (!isCurrent()) return;
    const epoch = ++progressEpoch;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      const status = await api(url);
      if (!isCurrent() || epoch !== progressEpoch) return;
      if (status.state === 'not_started') {
        progress.textContent = 'This title has not been checked in Plex yet.';
      } else if (status.state === 'held') {
        progress.textContent = 'The check needs another try. No episodes were marked missing.';
      } else {
        const olderCount = Math.max(0,
          (status.lastVerifiedAvailableCount ?? status.recentAvailableCount) -
            status.recentAvailableCount);
        const olderText = olderCount
          ? ` · ${olderCount} found earlier, recheck needed` : '';
        progress.textContent = status.totalCount === null
          ? `Loading the episode list…${olderText}`
          : `${status.state === 'done' ? 'Finished: ' : ''}` +
            `${status.checkedCount} of ${status.totalCount} checked · ` +
            `${status.recentAvailableCount} playable in Plex${olderText}`;
      }
      if (['loading', 'checking'].includes(status.state)) {
        pollTimer = setTimeout(() => { void showProgress(); }, 15_000);
      }
    } catch { progress.textContent = 'Check progress is temporarily unavailable.'; }
  };
  checkTitle.addEventListener('click', async () => {
    checkTitle.disabled = true;
    try {
      await api(url, { method: 'POST', body: JSON.stringify({}) });
      await showProgress();
    } catch (error) { message(error.message, true); }
    finally { checkTitle.disabled = false; }
  });
  const summary = element('div', undefined, 'title-check-summary');
  summary.append(checkTitle, progress);
  void showProgress();
  return summary;
}
async function showDetail(item, franchise = null, refreshAttempt = 0) {
  const previousAction = state.selected === item.anidbId
    ? byId('detail').querySelector('.request-action[data-pending="true"]')
    : null;
  if (detailPollTimer !== null) clearTimeout(detailPollTimer);
  detailPollTimer = null;
  const detailRequest = detailResponses.invalidate();
  const isCurrentDetail = () => detailResponses.isCurrent(detailRequest) &&
    state.selected === item.anidbId;
  state.selected = item.anidbId;
  const panel = byId('detail');
  const loadingArt = element('div', 'N', 'detail-art poster-fallback');
  loadingArt.setAttribute('aria-hidden', 'true');
  const loadingPoster = posterImage(item);
  loadingPoster.addEventListener('load', () => loadingArt.classList.add('has-poster'));
  loadingArt.append(loadingPoster);
  const displaySummary = element('div', undefined, 'detail-display');
  const titleBlock = element('div', undefined, 'detail-title-block');
  const trackDetail = makeTrackButton(item);
  trackDetail.classList.add('detail-track-action');
  const trackingHelp=element('p','Tracking only changes your custom Airing list. Watching future episodes requests new downloads.','detail-tracking-help');trackingHelp.hidden=true;
  trackDetail.title='Adds to or removes from your custom Airing list; does not start or stop downloads.';
  const detailActionRow = (...controls) => {
    // Preferences may finish loading before this asynchronously built row is
    // attached. Refresh its controls after mounting, without another API read.
    requestAnimationFrame(updateTrackControls);
    const row = element('div', undefined, 'detail-action-row');
    if (controls.length === 1 && controls[0].classList.contains('request-action')) {
      const action = controls[0];
      const button = action.querySelector('.primary');
      const existing = button.closest('.detail-action-row');
      if (existing && action.contains(existing)) {
        existing.querySelector('.track-toggle')?.remove();
        existing.append(trackDetail,trackingHelp);
        return action;
      }
      button.replaceWith(row);
      row.append(button, trackDetail,trackingHelp);
      return action;
    }
    row.append(...controls, trackDetail,trackingHelp);
    return row;
  };
  titleBlock.append(titleLabel(item, { tag: 'h1', className: 'detail-title' }));
  panel.replaceChildren(loadingArt, titleBlock,
    element('p', 'Loading episode details…', 'muted'), displaySummary);
  // An uncached catalogue read must not make the request path wait for Shoko.
  const earlyRequest = previousAction ?? pendingTitleAction(item);
  const fallbackTimer = earlyRequest ? setTimeout(() => {
    if (!isCurrentDetail() || !panel.contains(loadingArt) ||
        !state.showAdult && state.searchItems.get(item.anidbId)?.adult !== false) return;
    panel.append(detailActionRow(earlyRequest));
  }, 4_000) : null;
  let displayRead = displayCache.get(item.anidbId);
  if (!displayRead) {
    displayRead = api(`/api/catalogue/${item.anidbId}/display`)
      .catch(() => null)
      .then((display) => {
        if (display?.state !== 'display' &&
          displayCache.get(item.anidbId) === displayRead) {
          displayCache.delete(item.anidbId);
        }
        return display;
      });
    displayCache.set(item.anidbId, displayRead);
    if (displayCache.size > 100) displayCache.delete(displayCache.keys().next().value);
  }
  let displayReleaseStatus = null;
  let nextAirData = null;
  let nextAirElement = null;
  const refreshNextAir = () => {
    if (!nextAirElement) return;
    const label = nextAirDateLabel({ kind: nextAirData.kind,
      releaseState: nextAirData.releaseState, releaseStatus: displayReleaseStatus,
      schedule: nextAirData.regularSchedule });
    nextAirElement.hidden = !label;
    nextAirElement.textContent = label ?? '';
  };
  const renderDisplay = (display, title) => {
    if (!isCurrentDetail() || display?.state !== 'display') return;
    if (display.restricted !== false &&
        (!state.showAdult || state.user?.adultAllowed !== true)) return;
    displayReleaseStatus = display.releaseStatus;
    refreshNextAir();
    panel.querySelector('.detail-title')?.replaceWith(titleLabel({ title,
      englishTitle: display.englishTitle ?? item.englishTitle },
    { tag: 'h1', className: 'detail-title' }));
    setPendingTitleKind(earlyRequest, { title },
      /movie|film/i.test(display.type ?? '') ? 'movie' :
        /series|tv|ova|ona/i.test(display.type ?? '') ? 'series' : null);
    displaySummary.replaceChildren();
    const main = element('div', undefined, 'detail-main');
    titleBlock.querySelectorAll('.detail-facts, .detail-alias').forEach(node => node.remove());
    const facts = [display.type, display.startYear, display.releaseStatus?.replaceAll('_', ' ').toLowerCase()].filter(Boolean).join(' · ');
    if (facts) titleBlock.append(element('p', facts, 'detail-facts'));
    if (display.englishTitle && display.englishTitle !== title) {
      const alias = element('p', detailAliasText(state.preferEnglish,
        title, display.englishTitle), 'detail-alias');
      alias.dataset.originalTitle = title;
      alias.dataset.titleAlias = display.englishTitle;
      titleBlock.append(alias);
    }
    const synopsis = typeof display.description === 'string'
      ? display.description.trim() : '';
    const description = element('p', synopsis ||
      'No synopsis is available for this title yet.', 'detail-description');
    main.append(description);
    if (synopsis) {
      if (synopsis.length > 280) {
        description.classList.add('is-collapsed');
        const toggle = element('button', 'Read full synopsis',
          'detail-description-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          const expanded = !description.classList.toggle('is-collapsed');
          toggle.setAttribute('aria-expanded', String(expanded));
          toggle.textContent = expanded ? 'Show less' : 'Read full synopsis';
        });
        main.append(toggle);
      }
    }
    const quickFacts = element('dl', undefined, 'detail-quickfacts');
    for (const [label, value] of [
      ['Season', display.season], ['Studio', display.studio],
      ['Runtime', display.durationMinutes ? `${display.durationMinutes} min` : null],
      ['First aired', display.startDate],
      ['Last aired', display.endDate],

    ]) {
      if (value === null || value === undefined || value === '') continue;
      const fact = element('div');
      fact.append(element('dt', label), element('dd', String(value)));
      quickFacts.append(fact);
    }
    if (display.tags?.length) {
      const tags = element('div', undefined, 'detail-tags');
      for (const tag of display.tags) tags.append(element('span', tag));
      main.append(tags);
    }
    displaySummary.append(main);
    if (quickFacts.childElementCount) displaySummary.append(quickFacts);
  };
  void displayRead.then((display) => {
    if (isCurrentDetail() && typeof display?.restricted === 'boolean') {
      state.searchItems.set(item.anidbId,
        { ...item, adult: display.restricted });
      applyAdultVisibility();
    }
    renderDisplay(display, item.title);
  });
  let requestAccess = null;
  try {
    const data = await api(`/api/catalogue/${item.anidbId}`)
      .finally(() => { if (fallbackTimer !== null) clearTimeout(fallbackTimer); });
    if (!isCurrentDetail()) return;
    requestAccess = data.requestsOpen !== false;
    if (typeof data.restricted === 'boolean') {
      state.searchItems.set(item.anidbId, { ...item, adult: data.restricted });
      applyAdultVisibility();
    }
    if (data.restricted === true && !state.showAdult) {
      panel.replaceChildren(element('p',
        '18+ titles are hidden. Turn on 18+ in the top right to view this title.', 'muted'));
      return;
    }
    const detailArt = element('div', 'N', 'detail-art poster-fallback');
    detailArt.setAttribute('aria-hidden', 'true');
    const detailPoster = posterImage(item);
    detailPoster.addEventListener('load', () => detailArt.classList.add('has-poster'));
    detailArt.append(detailPoster);
    const originalTitle = detailOriginalTitle(item, data);
    titleBlock.replaceChildren(titleLabel({ title: originalTitle,
      englishTitle: item.englishTitle }, { tag: 'h1', className: 'detail-title' }));
    panel.replaceChildren(detailArt, titleBlock);
    trackDetail.dataset.trackTitle = originalTitle;
    state.searchItems.set(item.anidbId, {
      ...item, ...state.searchItems.get(item.anidbId),
      title: originalTitle,
      ...(typeof data.restricted === 'boolean' ? { adult: data.restricted } : {}) });
    updateTrackControls();
    setPendingTitleKind(earlyRequest, { title: data.title || item.title }, data.kind);
    panel.append(displaySummary);
    if (state.titleChecks) panel.append(titleCheckSummary(item.anidbId, isCurrentDetail));
    void displayRead.then((display) => renderDisplay(display, originalTitle));
    if (data.state === 'detail_pending') {
      if (data.futureEpisodesMonitored) {
        const monitored = element('button', 'Future episodes already monitored', 'primary');
        monitored.type = 'button';
        monitored.disabled = true;
        panel.append(detailActionRow(monitored));
        if (data.activeWatchRequestId) {
          const existingRequest = element('a', 'View in My Requests →',
            'text-link request-receipt-link');
          existingRequest.href = requestRoute(data.activeWatchRequestId);
          panel.append(existingRequest);
        }
      } else {
        panel.append(element('p', requestAccess
          ? 'Episode details are not cached yet. You can request this title now; Negev will verify the exact entries before any download.'
          : 'Episode details are not cached yet. Anime requests for this title are temporarily unavailable in Negev. Please try again later.', 'muted'));
        const pendingAction = requestAccess ? earlyRequest : null;
        panel.append(detailActionRow(...(pendingAction ? [pendingAction] : [])));
      }
      if (state.detailLoad) {
        const preparationStatus = element('p', '', 'muted');
        const begin = async () => {
          state.detailHydrationQueued.add(item.anidbId);
          preparationStatus.textContent = 'Checking for an updated episode list in the background.';
          try {
            const hydration = await api(`/api/catalogue/${item.anidbId}/load-detail`,
              { method: 'POST', body: '{}' });
            state.detailHydrationQueued.delete(item.anidbId);
            if (isCurrentDetail()) {
              if (hydration.state === 'detail_ready') void showDetail(item, franchise, 1);
              else if (hydration.state === 'pending' &&
                  hydration.reason === 'refresh_queued') {
                preparationStatus.textContent = requestAccess
                  ? 'Episode details are updating. The request button is ready.'
                  : 'Episode details are updating.';
                detailPollTimer = setTimeout(() => {
                  void showDetail(item, franchise, 1);
                }, 4_000);
              } else {
                preparationStatus.textContent = requestAccess
                  ? 'Episode details are not ready yet. The request button is ready.'
                  : 'Episode details are not ready yet.';
              }
            }
          } catch (error) {
            state.detailHydrationQueued.delete(item.anidbId);
            if (isCurrentDetail()) {
              preparationStatus.textContent = requestAccess
                ? 'Episode details are busy. The request button is ready.'
                : 'Episode details are busy.';
            }
          }
        };
        panel.append(preparationStatus);
        if (refreshAttempt === 0 && !state.detailHydrationQueued.has(item.anidbId)) {
          void begin();
        } else {
          preparationStatus.textContent = requestAccess
            ? 'Episode details are not ready yet. The request button is ready.'
            : 'Episode details are not ready yet.';
        }
      }
    } else {
      state.detailHydrationQueued.delete(item.anidbId);
    }
    const pager = data.state === 'detail_pending' ? null : createEpisodePager(data);
    trackingHelp.hidden=data.releaseState!=='airing';
    const notReleased = data.releaseState === 'upcoming';
    if (pager) {
      const sourceDetails = element('details', undefined, 'detail-meta detail-source');
      sourceDetails.append(element('summary', 'Catalogue details'), element('p', `${data.kind === 'movie' ? 'Film' : 'Series'} · ${data.total} listed AniDB entr${data.total === 1 ? 'y' : 'ies'} · AniDB ${item.anidbId}`));
      panel.append(sourceDetails);
    }
    if (data.kind === 'series' && data.releaseState === 'airing') {
      nextAirData = data;
      nextAirElement = element('p', undefined,
        `detail-next-air${data.regularSchedule?.nextAirDate ? '' : ' unknown'}`);
      refreshNextAir();
      panel.append(nextAirElement);
    }
    let refreshAvailabilitySummary = () => {};
    if (notReleased) panel.append(element('p',
      'Not yet released. You can request this title now; Negev will watch for its release.',
      'detail-release-note'));
    if (pager && !notReleased) {
      const savedCount = data.libraryPresence?.state === 'in_library' &&
        Number.isSafeInteger(data.libraryPresence.verifiedEpisodeCount) &&
        data.libraryPresence.verifiedEpisodeCount > 0
        ? data.libraryPresence.verifiedEpisodeCount : 0;
      const summary = element('p');
      const evidence = element('details', undefined, 'availability-evidence');
      const evidenceText = element('p');
      evidence.append(element('summary', 'Availability details'), evidenceText);
      refreshAvailabilitySummary = () => {
        const headline = titleAvailabilitySummary({ kind: data.kind,
          episodes: pager.episodes, nextPage: pager.nextPage,
          regularSeason: data.regularSeason,
          regularSchedule: data.regularSchedule,
          monitorFuture: data.monitorFuture,
          verifiedTitleItems: savedCount });
        evidenceText.textContent = headline.text;
        const countMatch = headline.text.match(/(\d+) of (\d+) (aired )?regular episodes/);
        summary.textContent = countMatch
          ? countMatch[1] + ' of ' + countMatch[2] + (countMatch[3] ? ' aired episodes available' : ' episodes available')
          : headline.text.startsWith('Already available') ? 'Already available'
          : headline.text.split(' · ')[0];
        if (countMatch && Number(countMatch[1]) < Number(countMatch[2])) {
          summary.append(element('span', 'Remaining availability unconfirmed', 'availability-note'));
        }
        summary.className = `presence ${headline.state}`;
        const specials=pager.nextPage===null?pager.episodes.filter(episode=>episode.type==='Special'):null;
        if(specials?.length){
          const verified=specials.filter(episode=>episode.availability==='available').length;
          summary.append(element('span',verified?`${verified}/${specials.length} Special${specials.length===1?'':'s'} available`:'Specials unconfirmed',
            'special-coverage '+(verified===specials.length?'available':verified?'partial':'unknown')));
        }
      };
      refreshAvailabilitySummary();
      panel.append(summary, evidence);
      if (data.kind === 'series' && pager.nextPage !== null &&
          !data.regularSeason) {
        const refreshFullSeason = async (attempt) => {
          if (!isCurrentDetail() || pager.nextPage === null) return;
          try {
            const updated = await api(`/api/catalogue/${item.anidbId}`);
            if (!isCurrentDetail()) return;
            if (updated.state === 'details' &&
                updated.anidbId === data.anidbId &&
                updated.kind === data.kind && updated.total === data.total &&
                updated.restricted === data.restricted &&
                Number.isSafeInteger(updated.regularSeason?.total) &&
                Number.isSafeInteger(updated.regularSeason?.verified) &&
                updated.regularSeason.total > 0 &&
                updated.regularSeason.verified >= 0 &&
                updated.regularSeason.verified <= updated.regularSeason.total) {
              data.regularSeason = updated.regularSeason;
              data.regularSchedule = updated.regularSchedule;
              refreshAvailabilitySummary();
              refreshRequestAction();
              return;
            }
          } catch { /* Keep the page proof while the catalogue is busy. */ }
          if (attempt < 2 && isCurrentDetail()) {
            setTimeout(() => { void refreshFullSeason(attempt + 1); },
              attempt === 0 ? 2_000 : 3_000);
          }
        };
        setTimeout(() => { void refreshFullSeason(0); }, 1_000);
      }
    }
    if (pager?.episodes.length === 0 && !notReleased) panel.append(element('p',
      data.kind === 'movie'
        ? 'AniDB has no exact film entry listed yet. You can save a request; Negev will wait for an exact film entry before any download.'
        : 'AniDB has no episodes listed yet. An airing-series request can watch for future episodes.',
      'muted'));
    const family = franchise ?? createFranchiseExplorer({ anidbId: item.anidbId,
      title: data.title || item.title });
    const relatedDetails = createRelatedDetailCache({ read: (anidbId) =>
      api(`/api/catalogue/${anidbId}`,
        { signal: AbortSignal.timeout(5_000) }) });
    const checkedCards = new Set();
    const checkCard = (anidbId) => {
      if (checkedCards.has(anidbId)) return;
      checkedCards.add(anidbId);
      void relatedDetails.get(anidbId).then(() => {
        if (isCurrentDetail()) renderFamily();
      });
    };
    const relatedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          relatedObserver.unobserve(entry.target);
          checkCard(Number(entry.target.dataset.anidbId));
        }
      }
    }, { rootMargin: '250px' });
    const relatedButton = element('button', 'Show more related titles', 'text-link related-trigger');
    const relatedList = element('div', undefined, 'related-list');
    let relatedExpanded = false;
    const relatedRowCapacity = () => Math.max(1,
      getComputedStyle(relatedList).gridTemplateColumns.trim().split(/\s+/).length);
    let installmentSelect = null;
    let selectedInstallmentId = item.anidbId;
    let selectedAvailability = 'unknown';
    let selectedCheckVersion = 0;
    let updateRequestReview = () => {};
    let syncSeasonRows = () => {};
    const syncInstallmentChoice = () => {
      if (!installmentSelect) return;
      installmentSelect.replaceChildren();
      const titles = new Map(family.items().map((entry) =>
        [entry.anidbId, entry.title]));
      for (const entry of family.items()) {
        const source = entry.relatedFrom && entry.relatedFrom !== item.anidbId
          ? titles.get(entry.relatedFrom) : null;
        const option = element('option', entry.anidbId === item.anidbId
          ? `${entry.title} · this installment`
          : `${entry.title} · ${relationLabel(entry.relation)}` +
            (source ? ` via ${source}` : ''));
        option.value = String(entry.anidbId);
        installmentSelect.append(option);
      }
      installmentSelect.value = String(selectedInstallmentId);
    };
    const renderFamily = () => {
      relatedObserver.disconnect();
      relatedList.replaceChildren();
      const groups = groupFranchiseItems(family.items(), item.anidbId);
      const capacity = relatedRowCapacity();
      const allRelated = groups.flatMap((group) => group.items);
      const visibleIds = new Set((relatedExpanded ? allRelated :
        allRelated.slice(0, capacity)).map((entry) => entry.anidbId));
      const firstRowIds = new Set(allRelated.slice(0, capacity).map((entry) =>
        entry.anidbId));
      const titles = new Map(family.items().map((entry) =>
        [entry.anidbId, entry.title]));
      if (groups.length === 0) relatedList.append(element('p',
        'No related anime links are available from the current metadata. Other installments may still exist; search by title to find them.', 'muted'));
      for (const group of groups) {
        // Direct relation labels already appear on each card. Keep those
        // cards together in one compact grid; only separate indirect hops.
        for (const installment of group.items) {
          if (!visibleIds.has(installment.anidbId)) continue;
          const open = element('button', undefined, 'related-card');
          open.title = installment.title;
          open.dataset.anidbId = String(installment.anidbId);
          const art = element('span', 'N', 'related-art poster-fallback');
          const image = posterImage(installment);
          image.addEventListener('load', () => art.classList.add('has-poster'));
          art.append(image);
          const copy = element('span', undefined, 'related-copy');
          const relation = relationLabel(installment.relation);
          const source = installment.relatedFrom === item.anidbId ? null
            : titles.get(installment.relatedFrom);
          copy.append(element('small', source
            ? `${relation} · via ${source}` : relation, 'related-relation'));
          copy.append(element('strong', installment.title));
          const relatedDetail = relatedDetails.peek(installment.anidbId);
          const knownCount = installment.libraryPresence?.state === 'in_library'
            ? installment.libraryPresence.verifiedEpisodeCount : 0;
          const availabilityText = relatedDetail
            ? relatedAvailabilityText(relatedDetail) : knownCount > 0
              ? `${knownCount} verified item${knownCount === 1 ? '' : 's'} in library · loading details…`
              : 'Loading title details…';
          copy.append(element('span', availabilityText,
            `related-presence ${availabilityText.startsWith('Available')
              ? 'available' : availabilityText.startsWith('Partial')
                ? 'partial' : 'unconfirmed'}`));
          open.append(art, copy);
          open.addEventListener('click', () => {
            state.searchItems.set(installment.anidbId, installment);
            location.hash = titleRoute(installment.anidbId);
          });
          relatedList.append(open);
          if (firstRowIds.has(installment.anidbId)) {
            checkCard(installment.anidbId);
          } else relatedObserver.observe(open);
        }
      }
      const overflow = allRelated.length > capacity;
      relatedButton.textContent = 'Show more related titles';
      relatedButton.hidden = relatedExpanded || !overflow;
      relatedButton.disabled = relatedButton.hidden;
      syncInstallmentChoice();
      syncSeasonRows();
    };
    if (franchise) renderFamily();
    else {
      relatedList.append(element('p', 'Finding related titles…', 'muted'));
      relatedButton.textContent = 'Finding related titles…';
      relatedButton.disabled = true;
    }
    let relatedLoading = false;
    let lastRelatedFailure = null;
    let syncSeasonLookup = () => {};
    let expandForOpenPopup = false;
    let openSeasonDialog = null;
    const loadRelated = async ({ batch = false, initial = false } = {}) => {
      const next = family.next();
      if (!next || relatedLoading) return;
      relatedLoading = true;
      relatedButton.disabled = true;
      relatedButton.textContent = 'Loading related titles…';
      syncSeasonLookup();
      try {
        const result = await expandFranchiseBatch({ explorer: family,
          read: (anidbId) => api(`/api/catalogue/${anidbId}/related`),
          maxReads: initial ? 12 : batch ? 8 : 1,
          minNewItems: initial ? Math.min(49, Math.max(1,
            relatedRowCapacity() + 1 - (family.items().length - 1))) : batch ? 8 : 1,
          shouldContinue: isCurrentDetail });
        if (isCurrentDetail()) {
          renderFamily();
          lastRelatedFailure = result.failures === 0 ? null :
            result.state === 'rate_limited'
              ? 'Related titles are temporarily rate limited. Try again in about a minute.'
              : result.state === 'temporarily_unavailable'
              ? 'Related titles are temporarily unavailable. Try again shortly.'
              : result.state === 'root_unavailable'
              ? 'Related titles could not be loaded. Try again or search for another installment.'
              : 'Some relationships could not be loaded. You can open that title directly or continue exploring.';
          if (!lastRelatedFailure) return;
          const error = element('p', lastRelatedFailure, 'muted related-error');
          if (relatedList.querySelector('.related-card')) {
            relatedList.querySelector('.related-error')?.remove();
            relatedList.append(error);
          } else relatedList.replaceChildren(error);
          if (family.next()) {
            relatedButton.textContent = 'Try related titles again';
            relatedButton.hidden = false;
            relatedButton.disabled = false;
          }
        }
      } catch {
        if (!isCurrentDetail()) return;
        lastRelatedFailure = 'Related titles could not be loaded. Try again shortly.';
        renderFamily();
        relatedList.querySelector('.related-error')?.remove();
        relatedList.append(element('p', lastRelatedFailure, 'muted related-error'));
        relatedButton.textContent = 'Try related titles again';
        relatedButton.hidden = false;
        relatedButton.disabled = false;
      } finally {
        relatedLoading = false;
        syncSeasonLookup();
        if (expandForOpenPopup) {
          expandForOpenPopup = false;
          if (openSeasonDialog?.open && family.next() && !lastRelatedFailure) {
            void loadRelated({ batch: true });
          }
        }
      }
    };
    relatedButton.addEventListener('click', () => {
      if (!relatedExpanded && family.items().length - 1 > relatedRowCapacity()) {
        relatedExpanded = true;
        renderFamily();
      }
      if (family.next()) void loadRelated({ batch: true });
    });
    const relatedHeading = element('h2', 'Related titles', 'related-heading');
    panel.append(relatedHeading, relatedList, relatedButton);
    let relatedWidth = -1;
    let initialRelatedStarted = false;
    const relatedResize = new ResizeObserver(([entry]) => {
      if (!isCurrentDetail()) { relatedResize.disconnect(); return; }
      const width = Math.round(entry.contentRect.width);
      if (width <= 0 || width === relatedWidth) return;
      relatedWidth = width;
      renderFamily();
      // Grid capacity is unreliable before the panel is mounted. Fill the
      // actual visible row (plus one overflow card) after layout is known.
      if (!initialRelatedStarted && family.next() &&
          family.items().length - 1 <= relatedRowCapacity()) {
        initialRelatedStarted = true;
        void loadRelated({ initial: true });
      }
    });
    relatedResize.observe(relatedList);
    if (!pager) return;
    let filmChoiceSelect = null;
    let refreshRequestAction = () => {};
    let refreshSelectedRequestAction = () => {};
    const likelyCompleteSeries = data.kind === 'series' &&
      data.monitorFuture !== true &&
      installmentRequestState({ kind: data.kind,
        episodes: pager.episodes, nextPage: pager.nextPage,
        regularSeason: data.regularSeason }) !== 'already_available' &&
      data.endDate && data.endDate < new Date().toISOString().slice(0, 10) &&
      Number.isSafeInteger(data.episodeCount) && data.episodeCount > 0 &&
      data.libraryPresence?.state === 'in_library' &&
      data.libraryPresence.verifiedEpisodeCount >= data.episodeCount &&
      pager.nextPage !== null;
    let checkingCompleteSeries = Boolean(likelyCompleteSeries);
    let loadNextEpisodePage = null;
    // One explicit check at a time: a pending or incomplete public observation
    // is Unknown, never a claim that an episode is missing.
    if (pager.episodes.length > 0 && !notReleased) {
      const check = element('div', undefined, 'availability-check');
      if (pager.episodes.some((episode) => episode.availability)) {
        check.append(element('p',
          'Playable labels use recent, verified public Plex evidence. Unlabelled episodes are not confirmed yet.',
          'muted'));
      }
      const label = element('label', data.kind === 'movie' ? 'Check a film target in Plex' : 'Check an episode in Plex');
      const select = element('select');
      const chooseFilmEntry = data.kind === 'movie' && data.total > 1;
      if (chooseFilmEntry) {
        const placeholder = element('option', 'Choose one film entry');
        placeholder.value = '';
        select.append(placeholder);
      }
      const optionText = (episode) => {
        const schedule = data.kind === 'series' && episode.type === 'Episode'
          ? episodeScheduleLabel(episode, data.scheduleAsOf ??
            data.regularSchedule?.asOf) : '';
        return `${episode.type === 'Episode' ? 'Episode' : episode.type} ${episode.number}` +
        `${episode.title && episode.title.toLowerCase() !== `episode ${episode.number}` ? ` · ${episode.title}` : ''}` +
        `${schedule ? ` · ${schedule}` : ''}` +
        `${episode.availability === 'available' ?
          episode.availabilityNote === 'alternate_card'
            ? ' · Playable in Plex; episode card not linked to this episode'
            : ' · Playable in Plex' :
          episode.availability === 'previously_available'
            ? ' · Previously playable; recheck needed' : ''}`;
      };
      const appendOptions = (episodes) => {
        for (const episode of episodes) {
          const option = element('option', optionText(episode));
          option.value = String(episode.id);
          select.append(option);
          if (filmChoiceSelect && episode.type === 'Episode') {
            filmChoiceSelect.append(option.cloneNode(true));
          }
        }
      };
      const updateOption = (episodeId, availability, presentation) => {
        const episode = pager.episodes.find((entry) => entry.id === episodeId);
        const option = [...select.options].find((entry) => entry.value === String(episodeId));
        if (episode && option) {
          episode.availability = availability;
          episode.availabilityNote = presentation === 'alternate_card'
            ? 'alternate_card' : undefined;
          option.textContent = optionText(episode);
          refreshAvailabilitySummary();
          refreshRequestAction();
          refreshSelectedRequestAction();
        }
      };
      appendOptions(pager.episodes);
      label.append(select);
      const button = element('button', data.kind === 'series'
        ? 'Check selected episode' : 'Check selected film entry');
      const result = element('p', '', 'muted');
      button.disabled = !select.value;
      select.addEventListener('change', () => {
        result.textContent = '';
        button.disabled = !select.value;
      });
      button.addEventListener('click', async () => {
        if (!select.value) return;
        button.disabled = true;
        select.disabled = true;
        result.textContent = 'Checking the public library…';
        try {
          const status = await api(`/api/catalogue/${item.anidbId}/episodes/${select.value}/availability?kind=${data.kind}`);
          if (status.state === 'available') {
            updateOption(Number(select.value), status.state, status.presentation);
          }
          select.dispatchEvent(new Event('change'));
          result.textContent = status.state === 'available' ?
            status.presentation === 'alternate_card'
              ? 'Playable in Plex; episode card not linked to this episode'
              : 'Playable in Plex' :
            'This entry could not be verified now. The season result above is unchanged.';
        } catch (error) { result.textContent = 'Availability check is temporarily unavailable'; }
        finally { button.disabled = !select.value; select.disabled = false; }
      });
      check.append(label, button, result);
      if (data.kind === 'series' && typeof data.restricted === 'boolean') {
        const requestSelected = element('button', 'Request selected episode');
        let requesting = false;
        const updateSelection = () => {
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          requestSelected.disabled = requesting ||
            !['Episode', 'Special'].includes(episode?.type) ||
            episode?.availability === 'available' ||
            episode?.type === 'Episode' &&
              episodeScheduleLabel(episode, data.scheduleAsOf ??
                data.regularSchedule?.asOf).startsWith('Upcoming');
          requestSelected.textContent = episode?.type === 'Special'
            ? 'Request this Special' : 'Request this episode';
        };
        select.addEventListener('change', updateSelection);
        updateSelection();
        requestSelected.addEventListener('click', async () => {
          if (requesting) return;
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          if (!['Episode', 'Special'].includes(episode?.type) ||
              episode.availability === 'available' ||
              episode.type === 'Episode' &&
                episodeScheduleLabel(episode, data.scheduleAsOf ??
                  data.regularSchedule?.asOf).startsWith('Upcoming')) return;
          const scope = { userId: state.user.id, anidbId: item.anidbId,
            selection: `episode-${episode.id}` };
          requesting = true;
          updateSelection();
          try {
            const saved = await api('/api/requests', { method: 'POST',
              body: JSON.stringify({ anidbId: item.anidbId, scope: 'episodes',
                episodeIds: [episode.id], requestKey: requestKeys.pending(scope) }) });
            requestKeys.saved(scope);
            message(`Request #${saved.requestId} saved for ${episode.type.toLowerCase()} ${episode.number}. ${currentAcquisitionNotice()}`);
            loadRequests();
          } catch (error) { message(error.message, true); }
          finally { requesting = false; updateSelection(); }
        });
        check.append(requestSelected);
      }
      if (chooseFilmEntry && typeof data.restricted === 'boolean') {
        const requestSelected = element('button', 'Request selected film entry');
        let requesting = false;
        const selectedFilmState = () => filmEntryRequestState({
          episodes: pager.episodes, nextPage: pager.nextPage,
          selectedId: Number(select.value),
        });
        const updateSelection = () => {
          requestSelected.disabled = requesting ||
            selectedFilmState() !== 'requestable';
        };
        refreshSelectedRequestAction = updateSelection;
        select.addEventListener('change', updateSelection);
        updateSelection();
        requestSelected.addEventListener('click', async () => {
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          if (requesting || selectedFilmState() !== 'requestable' ||
              episode?.type !== 'Episode') return;
          const scope = { userId: state.user.id, anidbId: item.anidbId,
            selection: `film-entry-${episode.id}` };
          requesting = true;
          updateSelection();
          try {
            const saved = await api('/api/requests', { method: 'POST',
              body: JSON.stringify({ anidbId: item.anidbId, scope: 'episodes',
                episodeIds: [episode.id], requestKey: requestKeys.pending(scope) }) });
            requestKeys.saved(scope);
            message(`Request #${saved.requestId} saved for film entry ${episode.number}. ${currentAcquisitionNotice()}`);
            loadRequests();
          } catch (error) { message(error.message, true); }
          finally { requesting = false; updateSelection(); }
        });
        check.append(requestSelected);
      }
      const advanced = element('details', undefined, 'episode-tools');
      advanced.append(element('summary', 'Episode and Special options'), check);
      panel.append(advanced);
      if (pager.nextPage !== null) {
        const more = element('button', 'Show more episodes');
        loadNextEpisodePage = async (notifyError = true) => {
          if (pager.nextPage === null || more.disabled) return false;
          more.disabled = true;
          try {
            const page = await api(`/api/catalogue/${item.anidbId}?page=${pager.nextPage}`);
            if (!isCurrentDetail()) return false;
            const added = pager.append(page);
            if (added.state !== 'appended') throw new Error('Episode list changed; select the title again');
            appendOptions(added.episodes);
            refreshAvailabilitySummary();
            refreshRequestAction();
            if (pager.nextPage === null) more.remove();
            else more.disabled = false;
            return true;
          } catch (error) {
            if (notifyError) message(error.message, true);
            more.disabled = false;
            return false;
          }
        };
        more.addEventListener('click', () => { void loadNextEpisodePage(); });
        advanced.append(more);
      }
    }
    if (typeof data.restricted !== 'boolean') {
      panel.append(element('p',
        'This title is not requestable until its catalogue status is verified.', 'muted'));
      return;
    }
    if (data.restricted) panel.append(element('p', '18+ title', 'badge partial'));
    if (data.kind === 'movie' && pager.episodes.length === 0) {
      const pendingFilmAction = earlyRequest ?? pendingTitleAction({ ...item,
        adult: data.restricted });
      setPendingTitleKind(pendingFilmAction,
        { title: data.title || item.title }, 'movie');
      panel.insertBefore(detailActionRow(...(pendingFilmAction ? [pendingFilmAction] : [])),
        relatedHeading);
      return;
    }
    // Keep the original control mounted while its save is in flight so the
    // asynchronous result and request number remain visible after hydration.
    if (earlyRequest?.dataset.saving === 'true' ||
        earlyRequest?.dataset.saved === 'true') {
      panel.insertBefore(detailActionRow(earlyRequest), relatedHeading);
      return;
    }
    if (data.kind === 'series') {
      const availableButton = element('button', 'Already available',
        'primary season-already-available');
      availableButton.type = 'button';
      availableButton.disabled = true;
      availableButton.hidden = true;
      const trigger = element('button', 'Request series', 'primary season-request-trigger');
      trigger.type = 'button';
      const monitoredButton = element('button', 'Future episodes already monitored',
        'primary season-already-monitored');
      monitoredButton.type = 'button';
      monitoredButton.disabled = true;
      monitoredButton.hidden = true;
      const monitoredLink = element('a', 'View in My Requests →',
        'text-link request-receipt-link');
      monitoredLink.href = '#/requests';
      monitoredLink.hidden = true;
      if (data.requestsOpen === false) panel.append(element('p',
        'Anime requests for this title are temporarily unavailable in Negev. Please try again later.',
        'muted request-preview-gate'));
      const action = element('dialog', undefined,
        'request-action season-request-action season-request-dialog');
      openSeasonDialog = action;
      const popupHeading = element('div', undefined, 'season-request-popup-heading');
      const headingTitle = element('h2', 'Request series');
      headingTitle.id = 'season-request-title';
      action.setAttribute('aria-labelledby', headingTitle.id);
      const closePopup = element('button', 'Close', 'quiet season-request-close');
      closePopup.type = 'button';
      closePopup.addEventListener('click', () => action.close());
      popupHeading.append(headingTitle, closePopup);
      action.append(popupHeading);
      action.append(element('p', notReleased
        ? 'Choose one or more installments to watch for their release. Specials stay separate.'
        : 'Choose the installments to request. Available episodes are skipped; Specials stay separate.',
      'muted'));
      const chooser = element('details', undefined, 'season-request-chooser');
      chooser.open = true;
      chooser.append(element('summary', 'Choose seasons'));
      const heading = element('div', undefined, 'season-request-header');

      const selectAll = element('button', 'Select all shown', 'quiet');
      selectAll.type = 'button';
      heading.append(selectAll);
      const list = element('div', undefined, 'season-request-list');
      const moreSeasons = element('button', 'Find more seasons or installments', 'quiet');
      moreSeasons.type = 'button';
      moreSeasons.classList.add('season-lookup-retry');
      const lookupNotice = element('p', '', 'muted season-lookup-notice');
      lookupNotice.setAttribute('role', 'status');
      syncSeasonLookup = () => {
        moreSeasons.hidden = family.next() === null;
        moreSeasons.disabled = relatedLoading;
        moreSeasons.textContent = lastRelatedFailure
          ? 'Retry finding seasons' : 'Find more seasons or installments';
        const incomplete = relatedLoading || !!lastRelatedFailure || !!family.next();
        lookupNotice.textContent = relatedLoading
          ? 'Finding linked seasons. This list is not complete yet.'
          : lastRelatedFailure
            ? `Season list incomplete. Other seasons may be missing. ${lastRelatedFailure}`
            : family.next()
              ? 'More linked seasons may exist. Find more before selecting all shown.'
              : '';
        lookupNotice.classList.toggle('incomplete', incomplete);
      };
      syncSeasonLookup();
      moreSeasons.addEventListener('click', () => { void loadRelated({ batch: true }); });
      chooser.append(heading, list, lookupNotice, moreSeasons);
      const review = element('div', undefined, 'request-review');
      review.hidden = true;
      review.append(element('strong', 'Review your request'));
      const reviewSummary = element('p');
      review.append(reviewSummary);
      let releaseMode='auto_review';
      const releasePicker=state.releaseSearch?{value:()=>releaseMode}:null;
      review.append(element('p',
        'Each selected installment becomes its own request. You can cancel a saved request in My Requests until processing starts.',
        'muted'));
      const cancel = element('button', 'Cancel', 'quiet');
      cancel.type = 'button';
      review.append(cancel);
      const submit = element('button', 'Select seasons', 'primary');
      submit.disabled = true;
      const modeActions=state.releaseSearch?makeReleaseActions(element,{
        onAuto:()=>{if(saving)return;releaseMode='auto_review';reviewing=true;submit.click();},
        onManual:()=>{if(saving)return;releaseMode='manual';reviewing=true;submit.click();}}):null;
      if(modeActions)submit.hidden=true;
      const scopeHint=element('p','Select a season to continue.','request-scope-hint');scopeHint.setAttribute('role','status');
      const feedback = element('p', '', 'muted request-feedback');
      feedback.setAttribute('role', 'status');
      const view = element('a', 'View in My Requests →',
        'text-link request-receipt-link');
      view.href = '#/requests';
      view.hidden = true;
      action.append(chooser, scopeHint, review, ...(modeActions?[modeActions.element]:[]), submit, feedback, view);
      const rows = new Map();
      let saving = false;
      let reviewing = false;
      const selectedRows = () => [...rows.values()].filter((row) =>
        row.input.checked && row.status?.selectable && !row.requested);
      const refresh = () => {
        const selected = selectedRows();
        scopeHint.textContent=seasonSelectionScope(selected);
        closePopup.disabled=saving;
        const selectable = [...rows.values()].filter((row) =>
          row.status?.selectable && !row.requested);
        const presentation = seasonTriggerPresentation([...rows.values()],
          item.anidbId, family.next() !== null);
        const currentMonitored = rows.get(item.anidbId)?.futureEpisodesMonitored === true;
        const otherRequestable = [...rows.values()].some((row) =>
          row.anidbId !== item.anidbId && row.status?.selectable &&
          !row.futureEpisodesMonitored && !row.requested);
        monitoredButton.hidden = !currentMonitored;
        const watchRequestId = rows.get(item.anidbId)?.activeWatchRequestId;
        monitoredLink.hidden = !watchRequestId;
        if (watchRequestId) monitoredLink.href = requestRoute(watchRequestId);
        availableButton.hidden = currentMonitored || !presentation.showAvailable;
        trigger.hidden = currentMonitored ? !otherRequestable && family.next() === null
          : !presentation.showTrigger;
        trigger.textContent = currentMonitored
          ? otherRequestable ? 'Request another installment' : 'Find other installments'
          : presentation.triggerText;
        trigger.classList.toggle('primary', !currentMonitored && !presentation.showAvailable);
        trigger.classList.toggle('quiet', currentMonitored || presentation.showAvailable);
        trigger.disabled = saving || (rows.size > 0 &&
          !canOpenSeasonRequest([...rows.values()], family.next() !== null));
        selectAll.disabled = saving || selectable.length === 0;
        selectAll.textContent = selectable.length > 0 && selectable.every((row) => row.input.checked)
          ? 'Clear selection' : 'Select all shown';
        for (const row of rows.values()) {
          row.input.disabled = saving || row.requested || !row.status?.selectable;
          if (row.input.disabled && !saving) row.input.checked = false;
        }
        submit.disabled = saving || selected.length === 0;
        if(modeActions){modeActions.auto.disabled=submit.disabled;modeActions.manual.disabled=submit.disabled||selected.every(row=>row.status?.state==='upcoming');
          modeActions.manual.title=selected.every(row=>row.status?.state==='upcoming')?'Manual picking starts when episodes are released.':'';}
        submit.textContent = saving ? 'Saving requests…' : reviewing ? 'Confirm request' :
          selected.length === 0 ? 'Select seasons' : selected.length > 1
            ? `Request ${selected.length} seasons` : selected[0].status.state === 'partial'
              ? 'Request episodes' : selected[0].status.state === 'watching'
                ? 'Watch future episodes' : 'Request season';
        reviewSummary.textContent = seasonSelectionSummary(selected.map(row=>({...row,title:preferredDisplayTitle(row)})));
      };
      const updateRow = (row, detail) => {
        row.detail=detail;
        if(detail?.state==='details' && (detail.originalTitle || detail.title)) {
          row.title=detail.originalTitle||detail.title;
          row.englishTitle=detail.englishTitle;
          const label=titleLabel({title:row.title,englishTitle:detail.englishTitle},
            {tag:'span',className:'season-request-title'});
          row.titleElement.replaceWith(label);row.titleElement=label;
        }
        const status = row.anidbId === item.anidbId && checkingCompleteSeries
          ? { state: 'unverified', text: 'Checking complete season…', selectable: false }
          : seasonRequestStatus(detail);
        if (status === null) { row.element.remove(); rows.delete(row.anidbId); refresh(); return; }
        row.activeWatchRequestId = detail?.activeWatchRequestId ?? null;
        row.futureEpisodesMonitored = detail?.futureEpisodesMonitored === true ||
          row.activeWatchRequestId > 0;
        row.status = row.futureEpisodesMonitored
          ? { state: 'watching', text: 'Future episodes already monitored',
            selectable: false } : status;
        row.statusText.textContent = row.futureEpisodesMonitored
          ? 'Future episodes already monitored' : row.requested ? 'Requested' : status.text;
        row.count.textContent = Number.isSafeInteger(detail?.regularSeason?.total) &&
          detail.regularSeason.total > 0
          ? `${detail.regularSeason.total} episodes` : '';
        refresh();
      };
      const pending = [];
      let active = 0;
      const drain = () => {
        while (active < 3 && pending.length > 0) {
          const row = pending.shift();
          active++;
          void (async () => {
            try {
              const detail = await relatedDetails.get(row.anidbId);
              if (isCurrentDetail() && rows.get(row.anidbId) === row) {
                row.detailFailed = detail.state === 'detail_unavailable';
                updateRow(row, detail);
              }
            } catch {
              if (isCurrentDetail() && rows.get(row.anidbId) === row) {
                row.detailFailed = true;
                updateRow(row, { state: 'detail_unavailable' });
              }
            } finally {
              row.loading = false;
              if (isCurrentDetail() && rows.get(row.anidbId) === row) refresh();
              active--;
              drain();
            }
          })();
        }
      };
      const loadRow = (row) => {
        if (row.loading || pending.includes(row)) return;
        row.loading = true;
        row.detailFailed = false;
        row.statusText.textContent = 'Checking episode details…';
        pending.push(row);
        drain();
      };
      const addRow = (entry) => {
        if (rows.has(entry.anidbId)) return;
        const row = { anidbId: entry.anidbId, title: entry.title, englishTitle:entry.englishTitle,
          status: null, requested: false, detailFailed: false, loading: false };
        const label = element('label', undefined, 'season-request-row');
        label.dataset.anidbId = String(entry.anidbId);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.disabled = true;
        input.addEventListener('change', () => {
          reviewing = false;
          review.hidden = true;
          feedback.textContent = '';
          refresh();
        });
        const title = titleLabel(entry,{tag:'span',className:'season-request-title'});
        row.titleElement=title;
        const count = element('span', '', 'season-request-count');
        const statusText = element('span', 'Checking…', 'season-request-status');
        label.append(input, title, count, statusText);
        row.element = label;
        row.input = input;
        row.count = count;
        row.statusText = statusText;
        rows.set(entry.anidbId, row);
        list.append(label);
        if (entry.anidbId === item.anidbId) {
          updateRow(row, { ...data, episodes: pager.episodes,
            nextPage: pager.nextPage });
        } else if (relatedDetails.peek(row.anidbId)) {
          const detail = relatedDetails.peek(row.anidbId);
          row.detailFailed = detail.state === 'detail_unavailable';
          updateRow(row, detail);
        } else if (action.open || rows.size <= 8) loadRow(row);
      };
      syncSeasonRows = () => {
        for (const entry of family.items()) addRow(entry);
        syncSeasonLookup();
        refresh();
      };
      syncSeasonRows();
      let continueCheck = null;
      refreshRequestAction = () => {
        if (pager.nextPage === null) {
          checkingCompleteSeries = false;
          if (continueCheck) continueCheck.hidden = true;
        }
        const row = rows.get(item.anidbId);
        if (row) updateRow(row, { ...data, episodes: pager.episodes,
          nextPage: pager.nextPage });
      };
      selectAll.addEventListener('click', () => {
        const selectable = [...rows.values()].filter((row) =>
          row.status?.selectable && !row.requested);
        const select = !selectable.every((row) => row.input.checked);
        for (const row of selectable) row.input.checked = select;
        reviewing = false;
        review.hidden = true;
        feedback.textContent = '';
        refresh();
      });
      cancel.addEventListener('click', () => {
        reviewing = false;
        review.hidden = true;
        feedback.textContent = '';
        refresh();
      });
      trigger.addEventListener('click', () => {
        action.showModal();
        for (const row of rows.values()) {
          if (row.detailFailed || !row.status) loadRow(row);
        }
        if (family.next() && !lastRelatedFailure) {
          if (relatedLoading) expandForOpenPopup = true;
          else void loadRelated({ batch: true });
        }
      });
      action.addEventListener('close', () => {
        reviewing = false;
        review.hidden = true;
        refresh();
      });
      action.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
      submit.addEventListener('click', async () => {
        const selected = selectedRows();
        if (saving || selected.length === 0) return;
        if (selected.length > 20) {
          feedback.textContent = 'Choose up to 20 seasons at a time.';
          return;
        }
        if (!reviewing) {
          reviewing = true;
          review.hidden = false;
          feedback.textContent = 'Review the selected seasons, then confirm.';
          refresh();
          return;
        }
        if(releasePicker?.value()==='manual'){
          reviewing=false;review.hidden=true;action.close();
          await openPreviewReleaseRequests(selected.map(row=>({title:row.title,englishTitle:row.englishTitle,
            body:{anidbId:row.anidbId,scope:'installment',requestKey:requestKeys.pending({userId:state.user.id,anidbId:row.anidbId})},
            saved:()=>{requestKeys.saved({userId:state.user.id,anidbId:row.anidbId});row.requested=true;
              row.statusText.textContent='Requested';refresh();}})));
          return;
        }
        saving = true;
        refresh();
        const saved = [];
        let savedRequestId = null;
        const releaseJobs = [];
        const failed = [];
        let alreadyMonitored = 0;
        let closedByPilot = 0;
        const requesterId = state.user.id;
        const requestSession = sessionResponses.current();
        const responseIsCurrent = () => sessionResponses.isCurrent(requestSession) &&
          state.user?.id === requesterId && isCurrentDetail();
        try {
          const submittedSeasons = selected.map((row) => ({
            anidbId: row.anidbId,
            ...(releasePicker?{releaseMode:releasePicker.value()}:{}),
            requestKey: requestKeys.pending({ userId: requesterId, anidbId: row.anidbId }),
          }));
          const submittedKeys = new Map(submittedSeasons.map(season =>
            [season.anidbId, season.requestKey]));
          const result = await api('/api/requests/seasons', { method: 'POST',
            body: JSON.stringify({ seasons: submittedSeasons }) });
          if (!responseIsCurrent()) return;
          for (const itemResult of result.items ?? []) {
            const row = rows.get(itemResult.anidbId);
            if (!row || !submittedKeys.has(row.anidbId)) continue;
            const payload = itemResult.result ?? {};
            requestKeys.rejected({ userId: requesterId, anidbId: row.anidbId },
              payload, submittedKeys.get(row.anidbId));
            if (itemResult.status >= 200 && itemResult.status < 300) {
              if (Number.isSafeInteger(payload.requestId) && payload.requestId > 0) {
                savedRequestId ??= payload.requestId;
              }
              requestKeys.saved({ userId: requesterId, anidbId: row.anidbId },
                submittedKeys.get(row.anidbId));
              row.requested = true;
              if (payload.reason === 'already_monitored') {
                alreadyMonitored++;
                row.activeWatchRequestId = payload.requestId;
                row.status = { state: 'watching',
                  text: 'Future episodes already monitored', selectable: false };
                row.statusText.textContent = 'Future episodes already monitored';
              } else {
                row.statusText.textContent = payload.state === 'pending'
                  ? 'Queued for details' : 'Requested';
                if(payload.created!==false&&payload.targetIds?.length!==0&&Number.isSafeInteger(payload.requestId))releaseJobs.push({requestId:payload.requestId,title:row.title,englishTitle:row.englishTitle});
                saved.push(Number.isSafeInteger(payload.requestId)
                  ? `#${payload.requestId}` : row.title);
              }
            } else if (payload.reason === 'already_available') {
              row.status = { state: 'available', text: 'Already available', selectable: false };
              row.statusText.textContent = 'Already available';
            } else if (payload.reason === 'already_monitored_elsewhere') {
              row.futureEpisodesMonitored = true;
              row.status = { state: 'watching',
                text: 'Future episodes already monitored', selectable: false };
              row.statusText.textContent = 'Future episodes already monitored';
              alreadyMonitored++;
            } else if (payload.reason === 'title_not_in_cutover') {
              row.status = { state: 'closed', text: 'Requests not open yet', selectable: false };
              row.statusText.textContent = requestFailureMessage(payload);
              closedByPilot++;
              failed.push(row.title);
            } else {
              row.statusText.textContent = payload.error ?? payload.reason ?? 'Could not save';
              failed.push(row.title);
            }
          }
          if (saved.length) refreshTrackingAfterRequest();
        } catch (error) {
          if (!responseIsCurrent()) return;
          for (const row of selected) {
            row.statusText.textContent = requestFailureMessage(error);
            failed.push(row.title);
          }
        }
        saving = false;
        reviewing = false;
        review.hidden = true;
        feedback.textContent = saved.length
          ? `${saved.length} season${saved.length === 1 ? '' : 's'} requested · ${saved.join(', ')}${failed.length ? ` · ${failed.length} could not be saved; retry those seasons` : ''}`
          : alreadyMonitored && !failed.length
            ? 'Future episodes are already monitored. View the existing request under My Requests.'
          : failed.length && closedByPilot === failed.length
            ? 'Anime requests for these titles are temporarily unavailable in Negev. Please try again later.'
            : failed.length ? `${failed.length} season${failed.length === 1 ? '' : 's'} could not be saved. Retry or open My Requests.`
            : 'Selected seasons are already available.';
        view.hidden = savedRequestId === null && saved.length === 0;
        view.href = savedRequestId !== null ? requestRoute(savedRequestId) : '#/requests';
        refresh();
        if (saved.length) loadRequests();
        if(isCurrentDetail()&&!failed.length&&releaseJobs.length&&releasePicker){action.close();void openSavedReleaseRequests(releaseJobs,releasePicker.value());}
      });
      if (checkingCompleteSeries && loadNextEpisodePage) {
        continueCheck = element('button', 'Continue availability check', 'quiet');
        continueCheck.hidden = true;
        continueCheck.type = 'button';
        panel.append(continueCheck);
        const checkPages = async () => {
          continueCheck.hidden = true;
          for (let page = 0; page < 20 && pager.nextPage !== null; page++) {
            if (!isCurrentDetail()) return;
            if (!await loadNextEpisodePage(false)) {
              if (!isCurrentDetail()) return;
              feedback.textContent = 'The season check could not finish. Try again.';
              continueCheck.hidden = false;
              return;
            }
          }
          if (!isCurrentDetail()) return;
          if (pager.nextPage !== null) {
            feedback.textContent = 'More episodes remain to check.';
            continueCheck.hidden = false;
            return;
          }
          checkingCompleteSeries = false;
          const row = rows.get(item.anidbId);
          if (row) updateRow(row, { ...data, episodes: pager.episodes,
            nextPage: pager.nextPage });
          feedback.textContent = '';
        };
        continueCheck.addEventListener('click', () => { void checkPages(); });
        void checkPages();
      }
      panel.insertBefore(detailActionRow(availableButton, trigger,
        monitoredButton, monitoredLink), relatedHeading);
      panel.append(action);
      return;
    }
    const requestAction = element('section', undefined, 'request-action');
    requestAction.append(element('h2', 'Request this installment'));
    requestAction.append(element('p', data.kind === 'movie'
      ? 'A film request includes one main film entry, not extras or trailers.'
      : notReleased
        ? 'This installment has not aired yet. The request will watch for its first episode. Other installments have separate requests.'
      : data.monitorFuture === true
        ? 'This airing installment includes its aired regular episodes and watches for new ones. Other installments have separate requests; Specials can be requested separately.'
        : 'This anime installment includes its regular episodes. Choose another season or installment under Related titles. Specials can be requested separately.',
    'muted'));
    if (data.kind === 'series') {
      const installmentLabel = element('label', 'Choose a season or installment',
        'installment-choice');
      installmentSelect = element('select');
      installmentSelect.addEventListener('change', () => {
        const selectedId = Number(installmentSelect.value);
        if (Number.isSafeInteger(selectedId) &&
            family.items().some((entry) => entry.anidbId === selectedId)) {
          if (selectedInstallmentId !== selectedId) {
            reviewingRequest = false;
            requestReview.hidden = true;
          }
          selectedInstallmentId = selectedId;
          selectedAvailability = selectedId === item.anidbId ? 'unknown' : 'checking';
          const checkVersion = ++selectedCheckVersion;
          requestStatus.textContent = '';
          updateRequestReview();
          refreshRequestAction();
          if (selectedId !== item.anidbId) {
            void checkSelectedAvailability(selectedId, checkVersion);
          }
        }
      });
      installmentLabel.append(installmentSelect);
      requestAction.append(installmentLabel);
      syncInstallmentChoice();
    }
    panel.insertBefore(requestAction, relatedHeading);
    const requestStatus = element('p', '', 'muted request-feedback');
    requestStatus.setAttribute('role', 'status');
    const viewRequest = element('a', 'View in My Requests →',
      'text-link request-receipt-link');
    viewRequest.href = '#/requests';
    viewRequest.hidden = true;
    const alreadyAvailable = () => selectedInstallmentId === item.anidbId
      ? installmentRequestState({ kind: data.kind,
        episodes: pager.episodes, nextPage: pager.nextPage,
        monitorFuture: data.monitorFuture,
        regularSeason: data.regularSeason }) === 'already_available'
      : selectedAvailability === 'already_available';
    const requestLabel = () => data.kind === 'movie'
      ? filmChoiceSelect?.value ? 'Request selected film' : 'Request film' :
      selectedInstallmentId !== item.anidbId ? 'Request selected installment' :
      data.monitorFuture === true && pager.episodes.some((episode) =>
        episode.type === 'Episode' && episode.availability === 'available')
        ? 'Watch future episodes' : 'Request series';
    const button = element('button', requestLabel(), 'primary');
    let requestSaving = false;
    let requestSaved = false;
    let reviewingRequest = earlyRequest?.dataset.reviewing === 'true';
    const requestReview = element('div', undefined, 'request-review');
    requestReview.hidden = !reviewingRequest;
    requestReview.append(element('strong', 'Review your request'));
    const reviewSummary = element('p', data.kind === 'movie'
      ? `${data.title || item.title} · one film entry`
      : `${data.title || item.title} · this installment’s regular episodes${data.monitorFuture === true ? ' and future episodes' : ''}`);
    requestReview.append(reviewSummary);
    let filmReleaseMode='auto_review';
    const filmReleasePicker=state.releaseSearch?{value:()=>filmReleaseMode}:null;
    const filmPopup=state.releaseSearch?element('dialog',undefined,'season-request-dialog release-request-submenu'):null;
    let filmActions=null,filmClose=null;
    const filmFeedback=element('p','','muted');filmFeedback.setAttribute('role','status');
    if(filmPopup){
      filmPopup.setAttribute('aria-label',data.kind==='movie'?'Request Movie':'Request Series');
      openSeasonDialog=filmPopup;
      const heading=element('div',undefined,'season-request-popup-heading');
      const close=element('button','Cancel','quiet');filmClose=close;close.addEventListener('click',()=>{if(!requestSaving)filmPopup.close();});
      heading.append(element('h2',data.kind==='movie'?'Request Movie':'Request Series'),close);
      filmPopup.append(heading,element('p',data.title||item.title));
      filmActions=makeReleaseActions(element,{
        onAuto:()=>{if(requestSaving)return;filmReleaseMode='auto_review';reviewingRequest=true;button.click();},
        onManual:()=>{if(requestSaving)return;filmReleaseMode='manual';reviewingRequest=true;button.click();}});
      filmPopup.append(filmActions.element,filmFeedback);requestAction.append(filmPopup);
      filmPopup.addEventListener('cancel',event=>{if(requestSaving)event.preventDefault();});
      filmPopup.addEventListener('close',()=>{reviewingRequest=false;requestReview.hidden=true;if(!requestSaved){requestStatus.textContent='';refreshRequestAction();}});
    }
    requestReview.append(element('p',
      'You can cancel the saved request until Negev starts processing a release. Cancellation does not remove files.',
      'muted'));
    updateRequestReview = () => {
      const selected = family.items().find((entry) => entry.anidbId === selectedInstallmentId);
      reviewSummary.textContent = selectedInstallmentId === item.anidbId
        ? `${data.title || item.title} · this installment’s regular episodes${data.monitorFuture === true ? ' and future episodes' : ''}`
        : `${selected?.title ?? 'Selected installment'} · Negev will check its film or episodes before saving`;
    };
    const cancelReview = element('button', 'Cancel', 'quiet');
    cancelReview.type = 'button';
    cancelReview.addEventListener('click', () => {
      reviewingRequest = false;
      requestReview.hidden = true;
      requestStatus.textContent = '';
      refreshRequestAction();
    });
    requestReview.append(cancelReview);
    refreshRequestAction = () => {
      if (requestSaving || requestSaved) return;
      const blocked = alreadyAvailable();
      const checkingSelected = selectedInstallmentId === item.anidbId
        ? checkingCompleteSeries : selectedAvailability === 'checking';
      button.disabled = blocked || checkingSelected;
      if(filmActions){filmActions.auto.disabled=button.disabled;filmActions.manual.disabled=button.disabled;}
      button.textContent = blocked ? 'Already available' :
        checkingSelected ? selectedInstallmentId === item.anidbId
          ? 'Checking availability…' : 'Checking selected installment…' :
          reviewingRequest ? 'Confirm request' : requestLabel();
      if (blocked) requestStatus.textContent = 'This installment is already verified in Negev’s Library.';
      else if (checkingSelected && selectedInstallmentId !== item.anidbId) {
        requestStatus.textContent = 'Checking this installment’s current Plex availability…';
      }
      else if (requestStatus.textContent === 'This installment is already verified in Negev’s Library.') {
        requestStatus.textContent = '';
      }
    };
    const checkSelectedAvailability = async (selectedId, checkVersion) => {
      let result = 'unknown';
      try {
        const selected = await api(`/api/catalogue/${selectedId}`, {
          signal: AbortSignal.timeout(4_000) });
        if (selected.state === 'details' && selected.anidbId === selectedId &&
            ['series', 'movie'].includes(selected.kind) &&
            Array.isArray(selected.episodes)) {
          result = installmentRequestState({ kind: selected.kind,
            episodes: selected.episodes, nextPage: selected.nextPage,
            monitorFuture: selected.monitorFuture,
            regularSeason: selected.regularSeason });
        }
      } catch { /* The final request check remains authoritative. */ }
      if (!isCurrentDetail() || checkVersion !== selectedCheckVersion ||
          selectedInstallmentId !== selectedId) return;
      selectedAvailability = result;
      requestStatus.textContent = result === 'unknown'
        ? 'Availability could not be confirmed here. Negev will check before saving.' : '';
      refreshRequestAction();
    };
    refreshRequestAction();
    const filmEntries = data.kind === 'movie'
      ? pager.episodes.filter((episode) => episode.type === 'Episode') : [];
    const needsFilmChoice = data.kind === 'movie' &&
      (filmEntries.length !== 1 || pager.nextPage !== null);
    let filmChoice;
    if (needsFilmChoice) {
      filmChoice = element('div', undefined, 'film-request-choice');
      filmChoice.hidden = true;
      const label = element('label', 'Choose the film version or part');
      filmChoiceSelect = element('select');
      filmChoiceSelect.addEventListener('change', () => {
        reviewingRequest = false;
        requestReview.hidden = true;
        requestStatus.textContent = '';
        refreshRequestAction();
      });
      const placeholder = element('option', 'Select a main film entry');
      placeholder.value = '';
      filmChoiceSelect.append(placeholder);
      for (const episode of filmEntries) {
        const option = element('option', `Episode ${episode.number}${episode.title ? ` · ${episode.title}` : ''}`);
        option.value = String(episode.id);
        filmChoiceSelect.append(option);
      }
      label.append(filmChoiceSelect);
      filmChoice.append(label);
      if (pager.nextPage !== null) filmChoice.append(element('p',
        'More film entries may be listed under Episode and Special options below.', 'muted'));
      if(filmPopup)filmPopup.insertBefore(filmChoice,filmActions.element);else requestAction.append(filmChoice);
    }
    button.addEventListener('click', async () => {
      if (alreadyAvailable() || selectedAvailability === 'checking' ||
          requestSaving || requestSaved) return;
      if(filmPopup&&!filmPopup.open){
        if(filmChoice)filmChoice.hidden=false;
        filmPopup.showModal();return;
      }
      if (needsFilmChoice && !filmChoiceSelect.value) {
        filmChoice.hidden = false;
        button.textContent = 'Request selected film';
        requestStatus.textContent = 'Choose one main film entry above.';
        filmChoiceSelect.focus();
        return;
      }
      if (!reviewingRequest) {
        if (needsFilmChoice) {
          const selectedFilm = pager.episodes.find((episode) =>
            String(episode.id) === filmChoiceSelect.value);
          reviewSummary.textContent = `${data.title || item.title} · ` +
            `main film entry ${selectedFilm?.number ?? '?'}${selectedFilm?.title ? ` · ${selectedFilm.title}` : ''}`;
        }
        reviewingRequest = true;
        requestReview.hidden = false;
        button.textContent = 'Confirm request';
        requestStatus.textContent = 'Review this installment, then confirm.';
        return;
      }
      if(filmReleasePicker?.value()==='manual'){
        const selectedFilmId=needsFilmChoice?Number(filmChoiceSelect.value):null;
        const keyScope={userId:state.user.id,anidbId:selectedInstallmentId,
          ...(selectedFilmId?{selection:'film-entry-'+selectedFilmId}:{})};
        filmPopup?.close();
        await openPreviewReleaseRequests([{title:data.title||item.title,englishTitle:data.englishTitle||item.englishTitle,
          body:{anidbId:selectedInstallmentId,scope:selectedFilmId?'episodes':'installment',
            ...(selectedFilmId?{episodeIds:[selectedFilmId]}:{}),requestKey:requestKeys.pending(keyScope)},
          saved:result=>{requestKeys.saved(keyScope);requestSaved=true;reviewingRequest=false;requestReview.hidden=true;
            button.textContent='Requested';button.disabled=true;requestStatus.textContent=savedRequestMessage(result);
            if(Number.isSafeInteger(result.requestId)&&result.requestId>0)viewRequest.href=requestRoute(result.requestId);
            viewRequest.hidden=false;}}]);
        return;
      }
      requestSaving = true;
      if(filmActions){filmActions.auto.disabled=true;filmActions.manual.disabled=true;filmClose.disabled=true;filmFeedback.textContent='Saving request…';}
      if (installmentSelect) installmentSelect.disabled = true;
      if (filmChoiceSelect) filmChoiceSelect.disabled = true;
      button.disabled = true;
      button.textContent = 'Saving request…';
      requestStatus.textContent = 'Saving your request…';
      const selectedFilmId = needsFilmChoice ? Number(filmChoiceSelect.value) : null;
      const scope = { userId: state.user.id, anidbId: selectedInstallmentId,
        ...(selectedFilmId ? { selection: `film-entry-${selectedFilmId}` } : {}) };
      try {
        const requestKey = requestKeys.pending(scope);
        const saved = await api('/api/requests', { method: 'POST', body: JSON.stringify({
          anidbId: selectedInstallmentId,
          scope: selectedFilmId ? 'episodes' : 'installment',
          ...(selectedFilmId ? { episodeIds: [selectedFilmId] } : {}), requestKey,
          ...(filmReleasePicker?{releaseMode:filmReleasePicker.value()}:{}),
        }) });
        requestKeys.saved(scope);
        refreshTrackingAfterRequest();
        requestSaved = true;
        reviewingRequest = false;
        requestReview.hidden = true;
        button.textContent = 'Requested';
        requestStatus.textContent = savedRequestMessage(saved);
        filmPopup?.close();
        if(isCurrentDetail()&&saved.created!==false&&filmReleasePicker&&Number.isSafeInteger(saved.requestId)){void openSavedReleaseRequests([{requestId:saved.requestId,title:data.title||item.title,englishTitle:data.englishTitle||item.englishTitle}],filmReleasePicker.value());}
        if (Number.isSafeInteger(saved.requestId) && saved.requestId > 0) {
          viewRequest.href = requestRoute(saved.requestId);
        }
        viewRequest.hidden = false;
        message(saved.state === 'pending'
          ? 'Request saved. Follow it under My Requests.'
          : `Request #${saved.requestId} saved. ${currentAcquisitionNotice()}`);
        loadRequests();
      } catch (error) {
        const feedback = requestFailureMessage(error);
        filmFeedback.textContent=feedback;if(filmClose)filmClose.disabled=false;
        requestStatus.textContent = feedback;
        message(feedback, true);
        requestSaving = false;
        if (installmentSelect) installmentSelect.disabled = false;
        if (filmChoiceSelect) filmChoiceSelect.disabled = false;
        refreshRequestAction();
      }
    });
    requestAction.append(requestReview, detailActionRow(button), requestStatus, viewRequest);
    if (checkingCompleteSeries && loadNextEpisodePage) {
      // A title-level count is only a hint. Keep the request closed until
      // every exact regular episode has been checked, even after page eight.
      const continueCheck = element('button', 'Continue availability check', 'quiet');
      continueCheck.hidden = true;
      continueCheck.type = 'button';
      requestAction.append(continueCheck);
      const checkPages = async () => {
        continueCheck.hidden = true;
        requestStatus.textContent = 'Checking the complete episode list…';
        for (let page = 0; page < 20 && pager.nextPage !== null; page++) {
          if (!isCurrentDetail()) return;
          if (!await loadNextEpisodePage(false)) {
            if (!isCurrentDetail()) return;
            requestStatus.textContent = 'The full availability check could not finish. Try again.';
            continueCheck.hidden = false;
            return;
          }
        }
        if (!isCurrentDetail()) return;
        if (pager.nextPage !== null) {
          requestStatus.textContent = 'More episodes remain to check before a new request can be made.';
          continueCheck.hidden = false;
          return;
        }
        checkingCompleteSeries = false;
        requestStatus.textContent = '';
        refreshRequestAction();
      };
      continueCheck.addEventListener('click', () => { void checkPages(); });
      void checkPages();
    }
  } catch (error) {
    if (!isCurrentDetail()) return;
    const retry = element('button', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => { void showDetail(item, franchise); });
    const unavailable = element('p', error.status === 429
      ? 'Episode details are temporarily unavailable because the server is busy. The title information above is still available; try again shortly.'
      : 'Episode details are temporarily unavailable. Try again to load request options.',
    'muted');
    titleBlock.replaceChildren(titleLabel(item, { tag: 'h1', className: 'detail-title' }));
    panel.replaceChildren(loadingArt, titleBlock, displaySummary, unavailable, retry);
    const pendingAction = requestAccess === false ? null : earlyRequest;
    panel.append(detailActionRow(...(pendingAction ? [pendingAction] : [])));
    void displayRead.then((display) => renderDisplay(display, item.title));
  }
}
void refreshSession();
const loadedClientRevision = document.querySelector(
  'meta[name="negev-client-revision"]')?.content;
let checkingClientRevision = false;
// A deploy must not discard an open dialog or typed text, so a new version
// is offered rather than loaded. "Later" hides the banner for that version.
let dismissedClientRevision = null;
byId('update-reload').addEventListener('click', () => { location.reload(); });
byId('update-dismiss').addEventListener('click', () => {
  dismissedClientRevision = byId('update-banner').dataset.revision ?? null;
  byId('update-banner').hidden = true;
});
async function refreshClientRevision() {
  if (!loadedClientRevision || checkingClientRevision || document.hidden) return;
  checkingClientRevision = true;
  try {
    const response = await fetch('/api/client-revision', { cache: 'no-store' });
    if (!response.ok) return;
    const { revision } = await response.json();
    if (!revision || revision === loadedClientRevision ||
        revision === dismissedClientRevision) return;
    // Nothing is open on the page: reloading now loses nothing.
    if (!state.user || (!document.querySelector('dialog[open]') &&
        !document.activeElement?.matches?.('input, textarea, select'))) {
      location.reload();
      return;
    }
    const banner = byId('update-banner');
    banner.dataset.revision = revision;
    banner.hidden = false;
  } catch { /* A connection failure is not a reason to disrupt this page. */ }
  finally { checkingClientRevision = false; }
}
setInterval(refreshClientRevision, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshClientRevision();
});
