import { createSessionController } from './session-controller.mjs';
import { createReleaseController } from './release-controller.mjs';
import { createApiClient } from './api-client.mjs';
import { createDetailController } from './detail-controller.mjs';
import { createSearchController } from './search-controller.mjs';
import { createSearchCard } from './search-card.mjs';
import { createBrowseController } from './browse-controller.mjs';
import { createTrackingController } from './tracking-controller.mjs';
import { createAuthController } from './auth-controller.mjs';
import { createRequestController } from './request-controller.mjs';
import { createAdminController } from './admin-controller.mjs';
import { createViewHelpers } from './view-helpers.mjs';

import { createRequestKeyStore, generateRequestKey } from './request-key.mjs';

import { createResponseEpoch } from './response-epoch.mjs';

import { acquisitionNotice } from './acquisition-notice.mjs';

import { hideChineseProduction } from './chinese-visibility.mjs';
import { parseConsumerRoute, searchRoute, librarySearchRoute, browseReturnDestination } from './consumer-route.mjs';

const byId = (id) => document.getElementById(id);
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

function invalidateRequestResponses() {
  requestResponses.watching.invalidate();
  requestResponses.history.invalidate();
  requestResponses.preparing.invalidate();
}
const reviewResponses = createResponseEpoch();

const libraryResponses = createResponseEpoch();
const airingResponses = createResponseEpoch();
const airingSeasonResponses = createResponseEpoch();
const seasonalResponses = createResponseEpoch();

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
function resetRoutePosition() {
  routePositions.clear();
  pendingScrollRestore = null;
  renderedHash = null;
}
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

const viewHelpers = createViewHelpers({ byId, state });
const { message, element, preferredDisplayTitle, titleLabel, applyTitlePreference, posterImage } = viewHelpers;
const currentAcquisitionNotice = () => acquisitionNotice(state.acquisitionState);

const tracking = createTrackingController({
  api: (...args) => api(...args),
  applyAdultVisibility: (...args) => applyAdultVisibility(...args),
  byId,
  element: (...args) => element(...args),
  loadAiring: (...args) => loadAiring(...args),
  markAdult: (...args) => markAdult(...args),
  message: (...args) => message(...args),
  sessionResponses,
  state
});
const { updateTrackControls, ensureTrackingPreferences, changeTrackingPreferences, refreshTrackingAfterRequest, makeTrackButton, trackedCard, renderTrackedTitles, handleViewModeChange } = tracking;

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
    search.invalidate();
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
      detail.invalidate();
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

const client = createApiClient({ clearWorkspace: (...args) => clearWorkspace(...args),
  refreshSession: (...args) => refreshSession(...args), requestKeys, sessionResponses, state });
const { api } = client;

const releases = createReleaseController({
  api: (...args) => api(...args),
  element: (...args) => element(...args),
  loadRequests: (...args) => loadRequests(...args),
  message: (...args) => message(...args),
  preferredDisplayTitle: (...args) => preferredDisplayTitle(...args),
  refreshTrackingAfterRequest: (...args) => refreshTrackingAfterRequest(...args),
  sessionResponses,
  state
});
const { releaseDialog, dismissRequestDialogs, openPreviewReleaseRequests, openSavedReleaseRequests } = releases;

// Fill the matching form from an invitation or reset link (once).
const auth = createAuthController({
  api: (...args) => api(...args),
  byId,
  clearWorkspace: (...args) => clearWorkspace(...args),
  message: (...args) => message(...args),
  refreshSession: (...args) => refreshSession(...args),
  sessionResponses,
  state
});
const { applyPendingLinkCode, authTab, retrySession, handleLoginSubmit, handleRegisterSubmit, signOut, handleResetSubmit } = auth;

const requestsView = createRequestController({
  api: (...args) => api(...args),
  byId,
  element,
  message,
  posterImage,
  preferredDisplayTitle,
  releaseDialog,
  requestResponses,
  restoreRoutePosition: (...args) => restoreRoutePosition(...args),
  sessionResponses,
  state,
  titleLabel
});
const { expandedRequestDetails, loadRequestView, requestGroupRows, renderRequestStatus, requestItemPresentation, refreshRequestStatusAges, refreshExpandedHistory, loadRequests, loadPreparations, refreshVisibleRequests } = requestsView;

setInterval(refreshVisibleRequests, 60_000);
document.addEventListener('visibilitychange', refreshVisibleRequests);
const browse = createBrowseController({
  airingResponses,
  airingSeasonResponses,
  api: (...args) => api(...args),
  byId,
  element: (...args) => element(...args),
  ensureTrackingPreferences: (...args) => ensureTrackingPreferences(...args),
  genreSelections,
  libraryResponses,
  markAdult: (...args) => markAdult(...args),
  posterImage: (...args) => posterImage(...args),
  renderTrackedTitles: (...args) => renderTrackedTitles(...args),
  restoreRoutePosition: (...args) => restoreRoutePosition(...args),
  seasonalResponses,
  sessionResponses,
  state,
  titleLabel: (...args) => titleLabel(...args),
  trackedCard: (...args) => trackedCard(...args)
});
const { loadLibrary, loadSeasonal, loadAiring, loadCurrentAiring, seasonChoice, stopLibraryPageObserver, stopBrowsePageObserver, publicPresenceBadge, scheduleFilterApply, handleSeasonSubmit, handleSeasonSort, handleAiringSubmit, handleAiringSort, handleFilterRouteChange, handleLibraryRefresh } = browse;

for (let year = new Date().getUTCFullYear() + 2; year >= 1900; year--) {
  const option = element('option', String(year));
  option.value = String(year);
  byId('season-year').append(option);
  byId('airing-year').append(option.cloneNode(true));
}

byId('season-form').addEventListener('submit', browse.handleSeasonSubmit);
byId('season-sort').addEventListener('change', browse.handleSeasonSort);
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

byId('airing-form').addEventListener('submit', browse.handleAiringSubmit);
byId('airing-sort').addEventListener('change', browse.handleAiringSort);
// Filters apply as soon as they change; there is no Apply button.

window.addEventListener('hashchange', browse.handleFilterRouteChange);
for (const [prefix, ids] of [['season', ['season-year', 'season-name', 'season-kind']],
  ['airing', ['airing-year', 'airing-season', 'airing-kind']]]) {
  for (const id of ids) byId(id).addEventListener('change', () => scheduleFilterApply(prefix));
}

byId('airing-view-mode').addEventListener('change', tracking.handleViewModeChange);
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('refresh-library').addEventListener('click', browse.handleLibraryRefresh);
byId('more-requests').addEventListener('click', () => { void loadRequestView('history', true); });
byId('more-preparations').addEventListener('click', () => { void loadPreparations(false, true); });
byId('more-watches').addEventListener('click', () => { void loadRequestView('watching', true); });
// Buttons offered for a parked review item. Retry re-runs every normal check;
// release only applies to a download that never started.
const admin = createAdminController({
  element,
  message,
  titleLabel,
  api: (...args) => api(...args),
  applyAdultVisibility: (...args) => applyAdultVisibility(...args),
  byId,
  readAdultPreference: (...args) => readAdultPreference(...args),
  reviewResponses,
  sessionResponses,
  state
});
const { reviewActionsFor, loadOperationalReview, showShareLink, createInviteLink, loadInvites, loadUsers } = admin;

byId('refresh-review').addEventListener('click', () => { void loadOperationalReview(); });
byId('more-review').addEventListener('click', () => { void loadOperationalReview(true); });

byId('login-tab').addEventListener('click', () => authTab(false));
byId('register-tab').addEventListener('click', () => authTab(true));
byId('session-retry').addEventListener('click', auth.retrySession);
byId('login-form').addEventListener('submit', auth.handleLoginSubmit);
byId('register-form').addEventListener('submit', auth.handleRegisterSubmit);
byId('signout').addEventListener('click', () => { void signOut(false); });
byId('signout-everywhere').addEventListener('click', () => { void signOut(true); });

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
const search = createSearchController({
  api: (...args) => api(...args),
  applyAdultVisibility: (...args) => applyAdultVisibility(...args),
  byId,
  element: (...args) => element(...args),
  message: (...args) => message(...args),
  restoreRoutePosition: (...args) => restoreRoutePosition(...args),
  searchResultCard: (...args) => searchResultCard(...args),
  sessionResponses,
  state
});
const { classifySearchCards, submitInlineSearch, handleSearchSubmit } = search;
// Shows a one-time link with a Copy button. The link is only shown here; the
// server keeps just a digest, so it cannot be displayed again later.
// `session` is sessionResponses.current() from before the request: a link
// that arrives after sign-out (or an account switch) is never shown.

byId('invite').addEventListener('click', () => { void createInviteLink(); });
byId('admin-create-invite').addEventListener('click', () => { void createInviteLink(); });
byId('reset-form').addEventListener('submit', auth.handleResetSubmit);

byId('refresh-invites').addEventListener('click', () => { void loadInvites(); });

byId('refresh-users').addEventListener('click', () => { void loadUsers(); });

const searchCard = createSearchCard({
  element: (...args) => element(...args),
  markAdult: (...args) => markAdult(...args),
  posterImage: (...args) => posterImage(...args),
  publicPresenceBadge: (...args) => publicPresenceBadge(...args),
  state,
  titleLabel: (...args) => titleLabel(...args),
  trackedCard: (...args) => trackedCard(...args)
});
const { searchResultCard } = searchCard;
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

byId('search-form').addEventListener('submit', search.handleSearchSubmit);
const detail = createDetailController({
  api: (...args) => api(...args),
  applyAdultVisibility: (...args) => applyAdultVisibility(...args),
  byId,
  currentAcquisitionNotice,
  displayCache,
  element: (...args) => element(...args),
  loadRequests: (...args) => loadRequests(...args),
  makeTrackButton: (...args) => makeTrackButton(...args),
  message: (...args) => message(...args),
  openPreviewReleaseRequests: (...args) => openPreviewReleaseRequests(...args),
  openSavedReleaseRequests: (...args) => openSavedReleaseRequests(...args),
  posterImage: (...args) => posterImage(...args),
  preferredDisplayTitle: (...args) => preferredDisplayTitle(...args),
  refreshTrackingAfterRequest: (...args) => refreshTrackingAfterRequest(...args),
  requestKeys,
  sessionResponses,
  state,
  titleLabel: (...args) => titleLabel(...args),
  updateTrackControls: (...args) => updateTrackControls(...args)
});
const { showDetail } = detail;

// Whole-title Plex check, for titles imported outside Negev (e.g. manually
// through Shoko). Shown only when the server enables NEGEV_TITLE_CHECK.

const session = createSessionController({
  admin,
  airingResponses,
  airingSeasonResponses,
  api: (...args) => api(...args),
  applyAdultVisibility: (...args) => applyAdultVisibility(...args),
  applyPendingLinkCode: (...args) => applyPendingLinkCode(...args),
  applyTitlePreference: (...args) => applyTitlePreference(...args),
  auth,
  browse,
  byId,
  currentAcquisitionNotice,
  detail,
  dismissRequestDialogs: (...args) => dismissRequestDialogs(...args),
  displayCache,
  element: (...args) => element(...args),
  ensureTrackingPreferences: (...args) => ensureTrackingPreferences(...args),
  genreSelections,
  invalidateRequestResponses: (...args) => invalidateRequestResponses(...args),
  libraryResponses,
  loadOperationalReview: (...args) => loadOperationalReview(...args),
  loadRequests: (...args) => loadRequests(...args),
  message: (...args) => message(...args),
  readAdultPreference: (...args) => readAdultPreference(...args),
  readChinesePreference: (...args) => readChinesePreference(...args),
  readEnglishTitlePreference: (...args) => readEnglishTitlePreference(...args),
  renderRoute: (...args) => renderRoute(...args),
  renderTrackedTitles: (...args) => renderTrackedTitles(...args),
  resetRoutePosition: (...args) => resetRoutePosition(...args),
  reviewResponses,
  seasonalResponses,
  sessionResponses,
  state,
  stopBrowsePageObserver: (...args) => stopBrowsePageObserver(...args),
  stopLibraryPageObserver: (...args) => stopLibraryPageObserver(...args),
  tracking,
  updateRequestScopeButtons: (...args) => updateRequestScopeButtons(...args)
});
const { showSession, clearWorkspace, refreshSession } = session;
void refreshSession();
setInterval(() => session.refreshVisibleSession(), 60_000);
document.addEventListener('visibilitychange', () => session.refreshVisibleSession());
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
