import { createRequestKeyStore, generateRequestKey } from './request-key.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { createSearchPager } from './search-pages.mjs';
import { createAdultSearchVerifier } from './adult-search-visibility.mjs';
import { requestPresentation } from './request-progress-text.mjs';
import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';
import { createResponseEpoch } from './response-epoch.mjs';
import { createFranchiseExplorer, expandFranchiseBatch } from './franchise-explorer.mjs';
import { acquisitionNotice } from './acquisition-notice.mjs';
import { titleAvailabilitySummary,
  installmentRequestState, filmEntryRequestState } from './season-availability-presentation.mjs';
import { detailRefreshDelay, detailHydrationFollowup } from './detail-refresh.mjs';
import { relationLabel } from './relation-label.mjs';
import { parseConsumerRoute, searchRoute, titleRoute,
  seasonRoute, browseReturnDestination } from './consumer-route.mjs';

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
  requestHistoryExpanded: false,
  showAdult: true, usersLoaded: false,
  detailHydrationQueued: new Set() };
const sessionResponses = createResponseEpoch();
const requestResponses = {
  watching: createResponseEpoch(), history: createResponseEpoch(),
  preparing: createResponseEpoch(),
};
const displayCache = new Map();
const adultSearchVerifier = createAdultSearchVerifier({ readDisplay: (id) =>
  api(`/api/catalogue/${id}/display`) });
function invalidateRequestResponses() {
  requestResponses.watching.invalidate();
  requestResponses.history.invalidate();
  requestResponses.preparing.invalidate();
}
const reviewResponses = createResponseEpoch();
const detailResponses = createResponseEpoch();
const libraryResponses = createResponseEpoch();
const airingResponses = createResponseEpoch();
const seasonalResponses = createResponseEpoch();
let nextReviewAttemptId = null;
let detailPollTimer = null;
const genreSelections = { season: new Set(), airing: new Set() };
let airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
function message(text, error = false) {
  const node = byId('message');
  node.textContent = text;
  node.classList.toggle('error', error);
}
const currentAcquisitionNotice = () => acquisitionNotice(state.acquisitionState);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function adultPreferenceKey(userId) { return `negev:show-adult:${userId}`; }
function readAdultPreference(userId) {
  try { return localStorage.getItem(adultPreferenceKey(userId)) !== 'off'; }
  catch { return true; }
}
function markAdult(node, item, { hideUnknown = false } = {}) {
  node.dataset.anidbId = String(item.anidbId);
  node.dataset.adult = item.adult === true ? 'true' :
    item.adult === false ? 'false' : 'unknown';
  node.hidden = !state.showAdult && (item.adult === true ||
    hideUnknown && item.adult !== false);
  return node;
}
function applyAdultVisibility() {
  for (const node of document.querySelectorAll('[data-anidb-id]')) {
    node.hidden = !state.showAdult && (node.dataset.adult === 'true' ||
      state.searchItems.get(Number(node.dataset.anidbId))?.adult === true ||
      node.closest('#results') && node.dataset.adult !== 'false');
  }
  const toggle = byId('adult-toggle');
  toggle.textContent = state.user?.adultAllowed === false ? '18+ Disabled' :
    state.showAdult ? '18+ On' : '18+ Off';
  toggle.setAttribute('aria-pressed', String(state.showAdult));
  toggle.disabled = state.user?.adultAllowed === false;
  toggle.title = toggle.disabled ? '18+ access is disabled for this account' :
    'Show or hide titles marked 18+';
}
const posterUrl = (item) => /^[0-9a-f-]{36}$/i.test(item.posterUid ?? '')
  ? `/api/catalogue/posters/${item.posterUid}`
  : `/api/catalogue/posters/anidb/${item.anidbId}`;
function posterImage(item, className = '') {
  const poster = document.createElement('img');
  poster.src = posterUrl(item);
  poster.alt = '';
  poster.loading = 'lazy';
  if (className) poster.className = className;
  poster.addEventListener('error', () => poster.classList.add('missing-art'));
  return poster;
}
function renderRoute() {
  if (!state.user) return;
  const route = parseConsumerRoute(location.hash);
  const page = route.page === 'admin' && state.user.role !== 'admin'
    ? 'discover' : route.page;
  const returning = state.routePage !== null && state.routePage !== page;
  state.routePage = page;
  const browseDestination = browseReturnDestination(route);
  if (browseDestination) state.lastBrowseDestination = browseDestination;
  for (const name of ['discover', 'airing', 'library', 'requests', 'title', 'admin']) {
    byId(`view-${name}`).hidden = name !== page;
  }
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
  if (page === 'discover') {
    byId('query').value = route.query;
    byId('search-results-section').hidden = route.query.length < 2;
    if (route.query.length >= 2 &&
        (returning || route.query !== state.lastSearchQuery)) {
      byId('search-form').requestSubmit();
    }
    const choice = seasonChoice(route);
    const key = `${choice.year}-${choice.season}-${choice.after}-${choice.kind}-${choice.tag}`;
    if (state.seasonalRouteKey !== key) {
      state.seasonalRouteKey = key;
      void loadSeasonal(choice);
    }
  } else if (page === 'library' && (returning || !state.libraryLoaded)) {
    void loadLibrary();
  } else if (page === 'requests' && returning) {
    void loadRequests();
  } else if (page === 'airing') {
    if (!state.airingLoaded) void loadAiring();
  } else if (page === 'admin' && !state.usersLoaded) {
    void loadUsers();
  }
}
window.addEventListener('hashchange', renderRoute);
window.addEventListener('popstate', renderRoute);
for (const tab of document.querySelectorAll('[data-request-tab]')) {
  tab.addEventListener('click', () => {
    const watching = tab.dataset.requestTab === 'watching';
    byId('request-history').hidden = watching;
    byId('request-watching').hidden = !watching;
    for (const button of document.querySelectorAll('[data-request-tab]')) {
      button.setAttribute('aria-selected', String(button === tab));
    }
  });
}
async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.csrf) {
    headers['x-negev-csrf'] = state.csrf;
  }
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.reason || `Request failed (${response.status})`);
    error.status = response.status;
    error.reason = data.reason;
    throw error;
  }
  return data;
}
function showSession(data) {
  if (state.user?.id !== data.user.id) {
    sessionResponses.invalidate();
    invalidateRequestResponses();
    reviewResponses.invalidate();
    detailResponses.invalidate();
    if (detailPollTimer !== null) clearTimeout(detailPollTimer);
    detailPollTimer = null;
    libraryResponses.invalidate();
    airingResponses.invalidate();
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
    state.libraryLoaded = false;
    state.libraryAfter = null;
    state.airingLoaded = false;
    state.airingPreferences = null;
    airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
    genreSelections.airing.clear();
    genreSelections.season.clear();
    state.seasonalRouteKey = null;
    state.routePage = null;
    nextReviewAttemptId = null;
  }
  state.user = data.user;
  state.showAdult = data.user.adultAllowed !== false &&
    readAdultPreference(data.user.id);
  state.csrf = data.csrfToken;
  state.releaseSearch = data.capabilities?.releaseSearch === true;
  state.detailLoad = data.capabilities?.detailLoad === true;
  state.titleChecks = data.capabilities?.titleChecks === true;
  state.acquisitionState = data.capabilities?.acquisitionState || 'disabled';
  byId('service-notice').textContent = data.capabilities?.availabilityChecks === true
    ? `Negev is in preview. ${currentAcquisitionNotice()} Public Plex availability can be checked; an unconfirmed result does not mean a file is missing.`
    : `Negev is in preview. ${currentAcquisitionNotice()} Public Plex checks are not active.`;
  byId('auth').hidden = true;
  byId('workspace').hidden = false;
  byId('main-nav').hidden = false;
  byId('mobile-nav').hidden = false;
  byId('search-form').hidden = false;
  byId('identity').hidden = false;
  byId('adult-toggle').hidden = false;
  applyAdultVisibility();
  byId('username').textContent = data.user.username;
  byId('invite').hidden = data.user.role !== 'admin';
  byId('admin-link').hidden = data.user.role !== 'admin';
  byId('admin-review').hidden = data.user.role !== 'admin';
  renderRoute();
}
function clearWorkspace() {
  sessionResponses.invalidate();
  invalidateRequestResponses();
  reviewResponses.invalidate();
  detailResponses.invalidate();
  if (detailPollTimer !== null) clearTimeout(detailPollTimer);
  detailPollTimer = null;
  libraryResponses.invalidate();
  airingResponses.invalidate();
  seasonalResponses.invalidate();
  state.user = null;
  state.showAdult = true;
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
  airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };
  genreSelections.airing.clear();
  genreSelections.season.clear();
  state.seasonalRouteKey = null;
  state.routePage = null;
  state.nextBeforeId = { watching: null, history: null, preparing: null };
  state.requestHistoryExpanded = false;
  nextReviewAttemptId = null;
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
  byId('adult-toggle').hidden = true;
  byId('identity').open = false;
  byId('workspace').hidden = true;
  byId('auth').hidden = false;
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
    if ([401, 403].includes(error?.status)) clearWorkspace();
    else message('Could not check your session. Reload to try again.', true);
    return false;
  }
}
async function loadRequestView(view, append = false, silent = false) {
  if (!state.user) return;
  const session = sessionResponses.current();
  const responseEpoch = requestResponses[view];
  const listRequest = responseEpoch.invalidate();
  const userId = state.user?.id;
  const watching = view === 'watching';
  const list = byId(watching ? 'watch-list' : 'request-list');
  const more = byId(watching ? 'more-watches' : 'more-requests');
  if (!append && !silent) {
    state.nextBeforeId[view] = null;
    more.hidden = true;
    list.replaceChildren(element('p', watching ? 'Loading watches…' : 'Loading requests…', 'muted'));
  }
  const suffix = append && state.nextBeforeId[view]
    ? `&beforeId=${state.nextBeforeId[view]}` : '';
  try {
    const page = await api(`/api/requests?view=${view}${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !responseEpoch.isCurrent(listRequest) || state.user?.id !== userId) return;
    if (!append) {
      list.replaceChildren();
      state.nextBeforeId[view] = null;
      more.hidden = true;
      if (!watching) state.requestHistoryExpanded = false;
    }
    if (!append && page.items.length === 0) {
      list.append(element('p', watching ? 'No Airing shows are being watched.' :
        'No finished or one-time requests yet. Search for an anime to begin.', 'muted'));
    }
    for (const item of page.items) {
      const row = element('div', undefined, 'request-row');
      row.dataset.recentPage = String(!append);
      row.append(posterImage(item));
      const heading = element('div');
      const targetCount = item.episodeIds.length;
      const requestedScope = item.kind === 'movie'
        ? targetCount === 1 ? 'Film requested' : `${targetCount} film parts requested`
        : `${targetCount} episode${targetCount === 1 ? '' : 's'} requested`;
      heading.append(element('strong', item.title ||
        `${item.kind === 'movie' ? 'Film' : 'Series'} · AniDB ${item.anidbId}`),
        element('small', `${item.kind === 'movie' ? 'Film' : 'Series'} · ` +
          `${requestedScope} · ` +
          `${item.monitorFuture ? (item.watchClosed ? 'Future-episode watch finished' : 'Watching for future episodes') : 'One-time request'}`));
      const openTitle = element('a', 'View title →', 'text-link');
      openTitle.href = titleRoute(item.anidbId);
      heading.append(openTitle);
      if (state.user?.role === 'admin') {
        const technical = element('details', undefined, 'request-technical');
        technical.append(element('summary', 'Technical details'),
          element('small', `AniDB ${item.anidbId} · Request #${item.id}`));
        heading.append(technical);
      }
      const presentation = requestItemPresentation(item);
      const status = element('div', undefined,
        `request-status status-${presentation.group}`);
      status.negevRequest = item;
      renderRequestStatus(status, presentation);
      row.append(heading, status);
      if (item.status === 'held') {
        const cancel = element('button', 'Cancel request', 'quiet');
        cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try {
            await api(`/api/requests/${item.id}/cancel`, {
              method: 'POST', body: JSON.stringify({}) });
            message('Request cancelled. Existing files have not been removed.');
            loadRequests();
          } catch (error) {
            message(error.message, true);
            cancel.disabled = false;
          }
        });
        heading.append(cancel);
      }
      if (state.user?.role === 'admin' && state.releaseSearch) {
        const button = element('button', 'Review release candidates');
        const candidates = element('div', undefined, 'candidate-list');
        button.addEventListener('click', async () => {
          button.disabled = true;
          candidates.replaceChildren(element('p', 'Searching indexers…', 'muted'));
          try {
            const result = await api(`/api/requests/${item.id}/candidates`);
            candidates.replaceChildren(element('p',
              'Unverified matches only. No download has started.', 'muted'));
            if (result.items.length === 0) {
              candidates.append(element('p', 'No candidates returned by this search.', 'muted'));
            }
            for (const candidate of result.items) {
              const entry = element('div');
              entry.append(element('p',
                `${candidate.title} · ${Math.round(candidate.size / 1_000_000)} MB · ` +
                `${candidate.seeders ?? '?'} seeders`));
              const inspect = element('button', 'Inspect files');
              const inspection = element('div');
              inspect.addEventListener('click', async () => {
                inspect.disabled = true;
                inspection.replaceChildren(element('p', 'Reading torrent file list…', 'muted'));
                try {
                  const preview = await api(`/api/requests/${item.id}/preflight`, {
                    method: 'POST', body: JSON.stringify({ candidate: {
                      guid: candidate.guid, indexerId: candidate.indexerId,
                      title: candidate.title, size: candidate.size,
                    } }),
                  });
                  inspection.replaceChildren(element('p',
                    `Torrent file list: ${preview.files.length} video file(s). ` +
                    'Episode identities are provisional. AniDB file registration is unverified. ' +
                    'No download has started.', 'muted'));
                  for (const file of preview.files) {
                    inspection.append(element('p',
                      `${file.name} → AniDB episode ${file.episodeIds.join(', ')}`));
                  }
                  for (const file of preview.subtitles) {
                    inspection.append(element('p', `${file.name} · subtitle`));
                  }
                  for (const file of preview.filesToExclude) {
                    inspection.append(element('p', `${file.name} · will be excluded before download`));
                  }
                } catch (error) {
                  inspection.replaceChildren(element('p',
                    `Cannot accept this file list: ${error.message}`, 'error'));
                } finally { inspect.disabled = false; }
              });
              entry.append(inspect, inspection);
              candidates.append(entry);
            }
          } catch {
            candidates.replaceChildren(element('p', 'Release search is unavailable right now.', 'muted'));
          } finally { button.disabled = false; }
        });
        const advanced = element('details', undefined, 'request-technical');
        advanced.append(element('summary', 'Advanced release tools'), button, candidates);
        row.append(advanced);
      }
      if (watching) list.append(row);
      else requestGroupRows(list, presentation.group).append(row);
    }
    state.nextBeforeId[view] = page.nextBeforeId;
    if (append && !watching) state.requestHistoryExpanded = true;
    more.hidden = state.nextBeforeId[view] === null;
    if (watching && state.requestHistoryExpanded) {
      const watched = new Set(page.items.map((item) => item.id));
      const history = byId('request-list');
      for (const status of history.querySelectorAll('.request-status')) {
        if (watched.has(status.negevRequest?.id)) {
          status.closest('.request-row')?.remove();
        }
      }
      for (const group of history.querySelectorAll('[data-request-group]')) {
        if (!group.querySelector('.request-row')) group.remove();
      }
    }
  } catch (error) {
    if (sessionResponses.isCurrent(session) &&
        responseEpoch.isCurrent(listRequest) && state.user?.id === userId) {
      if (!append && !silent) list.replaceChildren(element('p',
        'Could not load requests. Select Refresh to try again.', 'error'));
      if (!silent) message(error.message, true);
    }
  }
}
const historyGroupOrder = ['attention', 'active', 'completed'];
const historyGroupTitles = {
  attention: 'Needs attention', active: 'Active', completed: 'Completed',
};
function requestGroupRows(list, group) {
  const category = historyGroupOrder.includes(group) ? group : 'active';
  let section = [...list.children].find((child) =>
    child.dataset.requestGroup === category);
  if (!section) {
    section = element('section', undefined, 'request-group');
    section.dataset.requestGroup = category;
    section.append(element('h3', historyGroupTitles[category]),
      element('div', undefined, 'request-group-rows'));
    const next = [...list.children].find((child) =>
      historyGroupOrder.indexOf(child.dataset.requestGroup) >
      historyGroupOrder.indexOf(category));
    list.insertBefore(section, next ?? null);
  }
  return section.lastElementChild;
}
function renderRequestStatus(status, presentation) {
  status.className = `request-status status-${presentation.group}`;
  status.replaceChildren(element('strong', presentation.stage, 'request-stage'),
    element('span', presentation.detail, 'request-detail'));
  if (presentation.note) status.append(element('span', presentation.note,
    'request-note'));
}
function requestItemPresentation(item) {
  return item.status === 'cancelled'
    ? { stage: 'Cancelled', detail: 'No further downloads or episode monitoring.',
      note: 'Existing files remain in your library.', group: 'completed' }
    : requestPresentation(item.progress, item.kind,
      { monitorFuture: item.monitorFuture, watchClosed: item.watchClosed });
}
function refreshRequestStatusAges() {
  for (const status of document.querySelectorAll('.request-status')) {
    const item = status.negevRequest;
    if (!item?.progress?.transfer) continue;
    renderRequestStatus(status, requestItemPresentation(item));
  }
}
async function refreshExpandedHistory() {
  const session = sessionResponses.current();
  const epoch = requestResponses.history.invalidate();
  const userId = state.user?.id;
  try {
    const page = await api('/api/requests?view=history&limit=50');
    if (!sessionResponses.isCurrent(session) ||
        !requestResponses.history.isCurrent(epoch) ||
        state.user?.id !== userId || !state.requestHistoryExpanded) return;
    const latest = new Map(page.items.map((item) => [item.id, item]));
    const list = byId('request-list');
    const priorTop = [...list.querySelectorAll('.request-row[data-recent-page="true"]')]
      .map((row) => row.querySelector('.request-status')?.negevRequest?.id)
      .sort((a, b) => b - a);
    const currentTop = page.items.slice(0, 20).map((item) => item.id)
      .sort((a, b) => b - a);
    if (priorTop.length !== currentTop.length ||
        priorTop.some((id, index) => id !== currentTop[index])) {
      // A new request or a history/watch move changes membership. Rebuild the
      // newest page rather than leave a duplicate or hide the new request.
      void loadRequestView('history', false, true);
      return;
    }
    for (const status of list.querySelectorAll('.request-status')) {
      const item = latest.get(status.negevRequest?.id);
      if (!item) continue;
      status.negevRequest = item;
      const presentation = requestItemPresentation(item);
      renderRequestStatus(status, presentation);
      const row = status.closest('.request-row');
      if (row && row.parentElement !== requestGroupRows(list, presentation.group)) {
        requestGroupRows(list, presentation.group).append(row);
      }
    }
    for (const group of list.querySelectorAll('[data-request-group]')) {
      if (!group.querySelector('.request-row')) group.remove();
    }
  } catch { /* Keep loaded history and its retry control on a failed poll. */ }
}
function loadRequests({ silent = false } = {}) {
  if (!state.user) return;
  void loadPreparations(silent);
  void loadRequestView('watching', false, silent);
  void loadRequestView('history', false, silent);
}
async function loadPreparations(silent = false, append = false) {
  const session = sessionResponses.current();
  const epoch = requestResponses.preparing.invalidate();
  const userId = state.user?.id;
  const list = byId('preparing-list');
  const more = byId('more-preparations');
  try {
    const suffix = append && state.nextBeforeId.preparing
      ? `?beforeId=${state.nextBeforeId.preparing}` : '';
    const page = await api(`/api/request-preparations${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !requestResponses.preparing.isCurrent(epoch) ||
        state.user?.id !== userId) return;
    if (!append) list.replaceChildren();
    let section = list.querySelector('[data-request-group="preparing"]');
    if (!section && page.items?.some((item) => item.state !== 'cancelled')) {
      section = element('section', undefined, 'request-group');
      section.dataset.requestGroup = 'preparing';
      section.append(element('h3', 'Preparing requests'),
        element('div', undefined, 'request-group-rows'));
      list.append(section);
    }
    const rows = section?.lastElementChild;
    for (const item of page.items) {
      if (item.state === 'cancelled') continue;
      const row = element('div', undefined, 'request-row');
      row.append(posterImage(item));
      const heading = element('div');
      heading.append(element('strong', item.title),
        element('small', 'Preparing episode details'));
      const open = element('a', 'View title →', 'text-link');
      open.href = titleRoute(item.anidbId);
      heading.append(open);
      if (item.state === 'pending') {
        const cancel = element('button', 'Cancel request', 'quiet');
        cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try {
            await api(`/api/request-preparations/${item.id}/cancel`, {
              method: 'POST', body: '{}' });
            message('Request cancelled. No download was started.');
            loadRequests();
          } catch (error) { message(error.message, true); cancel.disabled = false; }
        });
        heading.append(cancel);
      }
      row.append(heading, element('p', item.state === 'complete'
        ? item.reason === 'already_available'
          ? 'Already available in Negev’s Library.'
          : item.reason === 'ambiguous_movie_scope'
            ? 'Choose a film part on the title page to request it.'
            : 'This title could not be requested automatically.'
        : item.state === 'resolving'
          ? 'Finishing the request. Cancellation is unavailable during this step.'
          : 'Waiting for a verified episode list before any download.',
      'muted'));
      rows.append(row);
    }
    state.nextBeforeId.preparing = page.nextBeforeId;
    more.hidden = page.nextBeforeId === null;
  } catch {
    if (!silent && sessionResponses.isCurrent(session) &&
        requestResponses.preparing.isCurrent(epoch)) {
      if (!append) list.replaceChildren(element('p',
        'Preparing requests are temporarily unavailable.', 'muted'));
    }
  }
}
function refreshVisibleRequests() {
  if (!state.user || state.routePage !== 'requests') return;
  refreshRequestStatusAges();
  if (document.hidden) return;
  if (state.requestHistoryExpanded) {
    void loadPreparations(true);
    void loadRequestView('watching', false, true);
    void refreshExpandedHistory();
  } else loadRequests({ silent: true });
}
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
  copy.append(element('strong', item.title), element('small', note),
    element('span', badge, `badge ${available ? 'ready' : 'unknown'}`));
  if (item.rating) {
    const members = new Intl.NumberFormat('en', { notation: 'compact',
      maximumFractionDigits: 1 }).format(item.rating.members);
    const rating = element('small', item.rating.score === null
      ? `${members} members · Unrated`
      : `★ ${item.rating.score.toFixed(1)} · ${members} members`,
    'muted rating-line');
    rating.title = `MAL snapshot via AniMap · ${item.rating.votes.toLocaleString()} ratings · ${item.rating.members.toLocaleString()} members · checked ${new Date(item.rating.checkedMs).toLocaleDateString()}`;
    copy.append(rating);
  }
  if (item.adult) copy.append(element('span', '18+', 'badge partial'));
  card.append(frame, copy);
  state.searchItems.set(item.anidbId, entry);
  return card;
}
function publicPresenceBadge(presence) {
  const available = presence?.state === 'in_library';
  const count = presence?.verifiedEpisodeCount ?? 0;
  return element('span', available
    ? `✓ In library · ${count} verified ${count === 1 ? 'item' : 'items'}`
    : 'Availability not checked',
  `presence ${available ? 'available' : 'unknown'}`);
}
async function loadLibrary(append = false, continuation = null) {
  const session = sessionResponses.current();
  const epoch = libraryResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('library-list');
  if (!append) {
    list.className = 'poster-grid';
    list.replaceChildren(element('p', 'Loading verified library titles…', 'muted'));
    state.libraryAfter = null;
  }
  try {
    const suffix = append && state.libraryAfter !== null
      ? `?afterAnidbId=${state.libraryAfter}` : '';
    const page = await api(`/api/library${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !libraryResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    if (!append) list.replaceChildren();
    else {
      continuation?.button.remove();
    }
    state.libraryLoaded = true;
    if (!append && page.items.length === 0) {
      list.append(element('p',
        'No titles have a recent exact public Plex proof yet. This is not a claim that your library is empty.',
        'empty-state'));
    }
    for (const item of page.items) {
      list.append(discoveryCard(item,
        `${item.verifiedEpisodeCount} verified ${item.verifiedEpisodeCount === 1 ? 'item' : 'items'}`,
        'In library', true));
    }
    state.libraryAfter = page.nextAfterAnidbId;
    if (state.libraryAfter !== null) {
      const more = element('button', 'Show more verified titles', 'text-link');
      more.type = 'button';
      let notice = null;
      more.addEventListener('click', () => {
        if (more.disabled) return;
        more.disabled = true;
        notice?.remove();
        notice = null;
        void loadLibrary(true, { button: more, showError() {
          more.disabled = false;
          more.textContent = 'Retry loading more titles';
          notice = element('p',
            'The next page could not be loaded. Titles already shown are still available.',
            'empty-state');
          more.after(notice);
        } });
      });
      list.append(more);
    }
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !libraryResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    if (!append) list.replaceChildren(element('p',
      'Library verification is unavailable right now. No missing titles are assumed.',
      'empty-state'));
    else continuation?.showError();
  }
}
function seasonChoice(route) {
  if (route.year !== undefined && route.season) return { year: route.year,
    season: route.season, after: route.after ?? 0,
    kind: route.kind ?? 'all', tag: route.tag ?? '' };
  return { year: 0, season: 'ALL', after: 0, kind: 'all', tag: '' };
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
async function loadSeasonal({ year, season, after, kind, tag }) {
  const session = sessionResponses.current();
  const epoch = seasonalResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('season-list');
  const notice = byId('season-state');
  byId('season-year').value = String(year);
  byId('season-name').value = season;
  byId('season-kind').value = kind;
  byId('season-previous').disabled = true;
  byId('season-next').disabled = true;
  byId('season-previous').parentElement.hidden = true;
  notice.textContent = year === 0 && season === 'ALL'
    ? 'Loading the anime catalogue…'
    : `Loading ${season === 'ALL' ? 'all seasons' : season.toLowerCase()} ${year || 'across all years'}…`;
  list.replaceChildren();
  try {
    const params = new URLSearchParams({ year: String(year), season });
    if (after) params.set('after', String(after));
    if (kind !== 'all') params.set('kind', kind);
    if (tag) params.set('tag', tag);
    const page = await api(`/api/seasons?${params}`);
    if (!sessionResponses.isCurrent(session) ||
        !seasonalResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    if (page.state === 'unavailable') {
      notice.textContent = 'Seasonal titles are unavailable right now. Search still works.';
      return;
    }
    renderGenres('season', page.availableTags ?? [], tag);
    notice.textContent = page.state === 'stale'
      ? `Showing a saved catalogue from ${page.sourceDate}; source refresh is unavailable.`
      : page.state === 'partial'
        ? `Catalogue updated ${page.sourceDate}. Some title details could not be checked; try again later.`
        : `Catalogue updated ${page.sourceDate}. Newest seasons first; local availability is checked separately.`;
    if (page.items.length === 0) list.append(element('p',
      'No verified titles on this page. Search may find titles missing from the season map.',
      'empty-state'));
    for (const item of page.items) {
      const button = markAdult(element('button', undefined, 'poster-card'), item);
      button.type = 'button';
      const frame = element('span', undefined, 'poster-frame');
      frame.append(posterImage(item));
      const copy = element('span', undefined, 'poster-copy');
      copy.append(element('strong', item.title),
        element('small', item.type || 'Anime'),
        publicPresenceBadge(item.libraryPresence));
      if (item.adult) copy.append(element('span', '18+', 'badge partial'));
      button.append(frame, copy);
      button.addEventListener('click', () => {
        state.searchItems.set(item.anidbId, item);
        location.hash = titleRoute(item.anidbId);
      });
      list.append(button);
    }
    const previous = byId('season-previous');
    const total = Number(page.total);
    const pageCount = Math.ceil(total / 12);
    const pageNumber = Math.floor(after / 12) + 1;
    const validPosition = Number.isSafeInteger(total) && total >= 0 &&
      pageNumber <= pageCount;
    previous.parentElement.hidden = !validPosition;
    if (validPosition) byId('season-page-position').textContent =
      `Page ${pageNumber} of ${pageCount}`;
    previous.disabled = after === 0;
    previous.onclick = () => { location.hash = seasonRoute(year, season,
      Math.max(0, after - 12), { kind, tag }); };
    const next = byId('season-next');
    next.disabled = page.nextAfter === null;
    next.onclick = () => { location.hash = seasonRoute(year, season,
      page.nextAfter, { kind, tag }); };
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !seasonalResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    notice.textContent = 'Seasonal browsing is unavailable right now. Search still works.';
  }
}
byId('season-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const year = Number(byId('season-year').value);
  const season = byId('season-name').value;
  const kind = byId('season-kind').value;
  const tag = [...genreSelections.season].join(',');
  if (!Number.isSafeInteger(year) || year !== 0 && (year < 1900 || year > 2100)) return;
  const route = seasonRoute(year, season, 0, { kind, tag });
  if (location.hash === route) void loadSeasonal({ year, season,
    after: 0, kind, tag });
  else location.hash = route;
});
async function loadCurrentAiring(session, epoch, userId, after = 0) {
  const list = byId('airing-season-list');
  const notice = byId('airing-season-state');
  const more = byId('airing-season-more');
  more.hidden = true;
  if (after === 0) {
    notice.textContent = 'Loading ongoing titles…';
    list.replaceChildren();
  }
  const { year, season, kind, tag, sort } = airingFilters;
  byId('airing-year').value = String(year);
  byId('airing-season').value = season;
  byId('airing-kind').value = kind;
  byId('airing-sort').value = sort;
  const params = new URLSearchParams({ year: String(year), season,
    status: 'ongoing', sort });
  if (kind !== 'all') params.set('kind', kind);
  if (tag) params.set('tag', tag);
  if (after) params.set('after', String(after));
  try {
    const page = await api(`/api/seasons?${params}`);
    if (!sessionResponses.isCurrent(session) ||
        !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    if (page.state === 'unavailable') {
      notice.textContent = 'The ongoing-title catalogue is unavailable right now.';
      return;
    }
    if (after === 0) renderGenres('airing', page.availableTags ?? [], tag);
    notice.textContent = page.orderState === 'score_loading'
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
        ? `✓ In library · ${count} verified ${count === 1 ? 'item' : 'items'}`
        : 'Availability not checked', available);
      const wrapper = element('div', undefined, 'tracked-title');
      const track = element('button', state.airingPreferences?.trackedAnidbIds
        .includes(item.anidbId) ? 'Stop tracking' : 'Track this title', 'quiet');
      track.type = 'button';
      track.setAttribute('aria-label', `${track.textContent}: ${item.title}`);
      track.addEventListener('click', async () => {
        const current = state.airingPreferences;
        if (!current) return;
        const ids = new Set(current.trackedAnidbIds);
        if (ids.has(item.anidbId)) ids.delete(item.anidbId);
        else ids.add(item.anidbId);
        track.disabled = true;
        try {
          state.airingPreferences = await api('/api/airing/preferences', {
            method: 'PUT', body: JSON.stringify({ mode: current.mode,
              trackedAnidbIds: [...ids] }) });
          if (current.mode === 'custom') {
            void loadAiring();
          } else {
            track.textContent = ids.has(item.anidbId) ? 'Stop tracking' : 'Track this title';
            track.setAttribute('aria-label', `${track.textContent}: ${item.title}`);
          }
        } catch (error) { notice.textContent = error.message; }
        finally { track.disabled = false; }
      });
      wrapper.append(card, track);
      list.append(wrapper);
    }
    if (after === 0 && page.orderState === 'score_loading') {
      setTimeout(() => {
        if (sessionResponses.isCurrent(session) &&
            airingResponses.isCurrent(epoch) &&
            state.user?.id === userId && state.routePage === 'airing') {
          void loadCurrentAiring(session, epoch, userId);
        }
      }, 30_000);
    }
    if (page.nextAfter !== null && page.nextAfter !== undefined) {
      more.hidden = false;
      more.onclick = () => { void loadCurrentAiring(session, epoch, userId,
        page.nextAfter); };
    } else if (!list.childElementCount) {
      list.append(element('p', 'No ongoing titles match these filters.',
        'empty-state'));
    }
  } catch {
    if (!sessionResponses.isCurrent(session) ||
        !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
    notice.textContent = 'The ongoing-title list is unavailable. This week’s schedule is separate.';
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
  const epoch = airingResponses.invalidate();
  void loadCurrentAiring(sessionResponses.current(), epoch, state.user?.id);
});
async function loadAiring() {
  const session = sessionResponses.current();
  const epoch = airingResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('airing-list');
  const notice = byId('airing-state');
  try {
    state.airingPreferences = await api('/api/airing/preferences');
  } catch {
    if (sessionResponses.isCurrent(session) && airingResponses.isCurrent(epoch)) {
      byId('airing-season-state').textContent = 'Airing preferences are unavailable. Try again.';
    }
    return;
  }
  if (!sessionResponses.isCurrent(session) ||
      !airingResponses.isCurrent(epoch) || state.user?.id !== userId) return;
  byId('airing-view-mode').value = state.airingPreferences.mode;
  byId('airing-mode-help').textContent = state.airingPreferences.mode === 'library'
    ? 'Shows with verified playable items in Negev’s Library.'
    : state.airingPreferences.mode === 'custom'
    ? 'Your selected shows. Switch to All airing anime to track more.'
    : 'All ongoing shows. Use Track this title to build a custom list.';
  void loadCurrentAiring(session, epoch, userId);
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
      copy.append(element('strong', item.title),
        element('small', `Episode ${item.episodeNumber} · scheduled ${item.scheduledDate}`),
        element('span', available
          ? '✓ Show has playable items' : 'Local availability not checked',
        `presence ${available ? 'available' : 'unknown'}`));
      if (item.adult) copy.append(element('span', '18+', 'badge partial'));
      button.append(art, copy);
      button.addEventListener('click', () => {
        state.searchItems.set(item.anidbId, item);
        location.hash = titleRoute(item.anidbId);
      });
      list.append(button);
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
  const previous = state.airingPreferences;
  if (!previous) return;
  const mode = select.value;
  select.disabled = true;
  try {
    state.airingPreferences = await api('/api/airing/preferences', {
      method: 'PUT', body: JSON.stringify({ mode,
        trackedAnidbIds: previous.trackedAnidbIds }) });
    state.airingLoaded = false;
    void loadAiring();
  } catch (error) {
    select.value = previous.mode;
    byId('airing-season-state').textContent = error.message;
  } finally { select.disabled = false; }
});
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('refresh-library').addEventListener('click', () => { void loadLibrary(); });
byId('more-requests').addEventListener('click', () => { void loadRequestView('history', true); });
byId('more-preparations').addEventListener('click', () => { void loadPreparations(false, true); });
byId('more-watches').addEventListener('click', () => { void loadRequestView('watching', true); });
async function loadOperationalReview(append = false) {
  if (state.user?.role !== 'admin') return;
  const session = sessionResponses.current();
  const read = reviewResponses.invalidate();
  const userId = state.user.id;
  const list = byId('review-list');
  if (!append) list.replaceChildren(element('p', 'Checking held work…', 'muted'));
  const suffix = append && nextReviewAttemptId !== null
    ? `?afterAttemptId=${nextReviewAttemptId}` : '';
  try {
    const page = await api(`/api/admin/review${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !reviewResponses.isCurrent(read) || state.user?.id !== userId) return;
    if (!append) list.replaceChildren();
    if (!append && page.items.length === 0) {
      list.append(element('p', 'Nothing needs review.', 'muted'));
    }
    for (const item of page.items) {
      const row = element('div', undefined, 'request-row');
      const label = item.stage === 'release_rejected'
        ? 'Downloaded file rejected' : item.stage === 'start_hold'
          ? 'Download start needs review' :
          item.stage === 'completion_interrupted'
            ? 'File check interrupted' : 'Import held';
      row.append(element('strong', `${label} · Request #${item.requestId}`),
        element('small', `AniDB ${item.anidbId} · ${item.reason.replaceAll('_', ' ')}`));
      list.append(row);
    }
    nextReviewAttemptId = page.nextAfterAttemptId;
    byId('more-review').hidden = nextReviewAttemptId === null;
  } catch (error) {
    if (sessionResponses.isCurrent(session) &&
        reviewResponses.isCurrent(read) && state.user?.id === userId) {
      list.replaceChildren(element('p', error.message, 'muted'));
    }
  }
}
byId('refresh-review').addEventListener('click', () => { void loadOperationalReview(); });
byId('more-review').addEventListener('click', () => { void loadOperationalReview(true); });
function authTab(register) {
  byId('login-form').hidden = register;
  byId('register-form').hidden = !register;
  byId('login-tab').classList.toggle('selected', !register);
  byId('register-tab').classList.toggle('selected', register);
  message('');
}
byId('login-tab').addEventListener('click', () => authTab(false));
byId('register-tab').addEventListener('click', () => authTab(true));
byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({
      username: fields.get('username'), password: fields.get('password'),
    }) });
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
  } catch (error) { message(error.message, true); }
});
byId('signout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  catch (error) { message(error.message, true); return; }
  clearWorkspace();
  message('Signed out.');
});
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
async function classifySearchCards(searchToken) {
  const userId = state.user?.id;
  const ids = [...document.querySelectorAll('#results [data-anidb-id]')]
    .filter((node) => node.dataset.adult === 'unknown')
    .map((node) => Number(node.dataset.anidbId));
  await adultSearchVerifier.verify(ids, (id, adult) => {
    if (state.searchToken !== searchToken || state.user?.id !== userId) return;
    const item = state.searchItems.get(id);
    if (item) state.searchItems.set(id, { ...item, adult });
    for (const node of document.querySelectorAll('#results [data-anidb-id]')) {
      if (Number(node.dataset.anidbId) === id) {
        node.dataset.adult = String(adult);
        if (adult && !node.querySelector('.adult-label')) {
          node.querySelector('.result-copy')?.append(
            element('span', '18+', 'badge partial adult-label'));
        }
      }
    }
    applyAdultVisibility();
  });
}
byId('invite').addEventListener('click', async () => {
  try {
    const result = await api('/api/invitations', { method: 'POST', body: '{}' });
    byId('invite-code').textContent = `Invitation code: ${result.code} · Expires in 7 days. Share it privately.`;
    byId('invite-code').hidden = false;
    message('Invitation ready to copy.');
  } catch (error) { message(error.message, true); }
});
async function loadUsers() {
  if (state.user?.role !== 'admin') return;
  const list = byId('admin-users');
  list.replaceChildren(element('p', 'Loading accounts…', 'muted'));
  try {
    const page = await api('/api/admin/users');
    if (state.user?.role !== 'admin') return;
    state.usersLoaded = true;
    list.replaceChildren();
    for (const user of page.items) {
      const row = element('div', undefined, 'user-setting');
      row.append(element('span', `${user.username} · ${user.role}`));
      const button = element('button', user.adultAllowed ? '18+ allowed' : '18+ blocked',
        'quiet');
      button.type = 'button';
      button.setAttribute('aria-label', `18+ access for ${user.username}`);
      button.setAttribute('aria-pressed', String(user.adultAllowed));
      button.disabled = user.disabled;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await api(`/api/admin/users/${user.id}/adult`, {
            method: 'PATCH', body: JSON.stringify({ allowed: !user.adultAllowed }) });
          user.adultAllowed = result.adultAllowed;
          button.textContent = user.adultAllowed ? '18+ allowed' : '18+ blocked';
          button.setAttribute('aria-pressed', String(user.adultAllowed));
          if (user.id === state.user.id) {
            state.user.adultAllowed = user.adultAllowed;
            state.showAdult = user.adultAllowed && readAdultPreference(user.id);
            applyAdultVisibility();
          }
        } catch (error) { message(error.message, true); }
        finally { button.disabled = user.disabled; }
      });
      row.append(button);
      list.append(row);
    }
  } catch {
    list.replaceChildren(element('p', 'Account settings are unavailable right now.', 'muted'));
  }
}
byId('refresh-users').addEventListener('click', () => { void loadUsers(); });
byId('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = byId('query').value.trim();
  if (query.length < 2) return;
  state.lastSearchQuery = query;
  const route = searchRoute(query);
  if (location.hash !== route) location.hash = route;
  const token = ++state.searchToken;
  const results = byId('results');
  byId('search-results-section').hidden = false;
  results.replaceChildren(element('p', 'Searching…', 'muted'));
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
      poster.addEventListener('error', () => poster.remove());
      tile.append(poster);
      const copy = element('span', undefined, 'result-copy');
      copy.append(element('strong', item.title),
        element('small', `AniDB ${item.anidbId}`));
      copy.append(publicPresenceBadge(item.libraryPresence));
      if (entry.adult === true) copy.append(
        element('span', '18+', 'badge partial adult-label'));
      button.append(tile, copy);
      button.addEventListener('click', () => { location.hash = titleRoute(item.anidbId); });
      results.append(button);
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
    if (data.items.length === 0) results.append(element('p', 'No matching titles in the current catalogue.', 'muted'));
    appendItems(data.items);
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
    results.replaceChildren(element('p', 'Search is unavailable right now.', 'muted'));
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
  const review = element('div', undefined, 'request-review');
  review.hidden = true;
  review.append(element('strong', 'Review your request'));
  review.append(element('p', `${item.title} · Negev will identify the film or episodes and check the library first`));
  const cancelReview = element('button', 'Cancel', 'quiet');
  cancelReview.type = 'button';
  cancelReview.addEventListener('click', () => {
    action.dataset.reviewing = 'false';
    review.hidden = true;
    button.textContent = 'Request if missing';
    status.textContent = '';
  });
  review.append(cancelReview);
  action.append(review, button, status);
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
      action.dataset.saving = 'false';
      action.dataset.saved = 'true';
      action.dataset.reviewing = 'false';
      review.hidden = true;
      button.disabled = true;
      button.textContent = 'Requested';
      status.textContent = savedRequestMessage(saved);
      message('Request saved. Follow it under My Requests.');
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
  panel.replaceChildren(loadingArt, element('h1', item.title, 'detail-title'),
    element('p', 'Loading episode details…', 'muted'), displaySummary);
  // Only offer a fallback if the first detail read is still loading after
  // ten seconds. Once it returns pending, the normal request action appears.
  const earlyRequest = previousAction ?? pendingTitleAction(item);
  const fallbackTimer = earlyRequest ? setTimeout(() => {
    if (!isCurrentDetail() || !panel.contains(loadingArt) ||
        !state.showAdult && state.searchItems.get(item.anidbId)?.adult !== false) return;
    panel.append(earlyRequest);
  }, 10_000) : null;
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
  const renderDisplay = (display, title) => {
    if (!isCurrentDetail() || display?.state !== 'display') return;
    if (display.restricted !== false &&
        (!state.showAdult || state.user?.adultAllowed !== true)) return;
    displaySummary.replaceChildren();
    const main = element('div', undefined, 'detail-main');
    const facts = [display.type, display.startYear].filter(Boolean).join(' · ');
    if (facts) main.append(element('p', facts, 'detail-facts'));
    if (display.englishTitle && display.englishTitle !== title) {
      main.append(element('p', `Also known as ${display.englishTitle}`,
        'detail-alias'));
    }
    if (display.description) {
      const description = element('p', display.description, 'detail-description');
      main.append(description);
      if (display.description.length > 600) {
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
      ['Format', display.type], ['Status', display.releaseStatus],
      ['Season', display.season], ['Studio', display.studio],
      ['Runtime', display.durationMinutes ? `${display.durationMinutes} min` : null],
      ['First aired', display.startDate],
      ['Last aired', display.endDate],
      ['Listed episodes', display.episodeCount],
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
  try {
    const data = await api(`/api/catalogue/${item.anidbId}`)
      .finally(() => { if (fallbackTimer !== null) clearTimeout(fallbackTimer); });
    if (!isCurrentDetail()) return;
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
    panel.replaceChildren(detailArt,
      element('h1', data.title || item.title, 'detail-title'));
    const pendingSummary = earlyRequest?.querySelector('.request-review p');
    if (pendingSummary) pendingSummary.textContent =
      `${data.title || item.title} · Negev will identify the film or episodes and check the library first`;
    panel.append(displaySummary);
    void displayRead.then((display) => renderDisplay(display, data.title || item.title));
    if (data.state === 'detail_pending') {
      if (!state.detailLoad) {
        panel.append(element('p', 'Episode details are not cached yet. You can save a request now; it will wait for exact episodes before any download.', 'muted'));
      } else {
        panel.append(element('p', 'Preparing episode details automatically. You can keep browsing; this page will update when they are ready.', 'muted'));
      }
      const pendingAction = earlyRequest;
      if (pendingAction) panel.append(pendingAction);
      if (state.detailLoad) {
        const retry = element('button', 'Retry loading details');
        retry.hidden = true;
        const preparationStatus = element('p', '', 'muted');
        const begin = async () => {
          state.detailHydrationQueued.add(item.anidbId);
          retry.hidden = true;
          preparationStatus.textContent = '';
          try {
            const hydration = await api(`/api/catalogue/${item.anidbId}/load-detail`,
              { method: 'POST', body: '{}' });
            const followup = detailHydrationFollowup(hydration, refreshAttempt);
            if (followup.state === 'retry' || followup.state === 'stop') {
              state.detailHydrationQueued.delete(item.anidbId);
            }
            if (isCurrentDetail()) {
              if (followup.state === 'ready') void showDetail(item, franchise);
              else if (followup.state === 'stop') {
                preparationStatus.textContent = 'Episode details are still unavailable. Try again later.';
                retry.hidden = false;
              } else {
                if (followup.state === 'retry') {
                  preparationStatus.textContent = 'Another title is being prepared. This one will retry automatically.';
                }
                detailPollTimer = setTimeout(() => {
                  void showDetail(item, franchise, refreshAttempt + 1);
                }, followup.delayMs);
              }
            }
          } catch (error) {
            state.detailHydrationQueued.delete(item.anidbId);
            if (isCurrentDetail()) {
              preparationStatus.textContent = error.status === 429
                ? 'Episode details are busy. You can request this title now; Negev will check the library before any download.'
                : 'Episode details could not be prepared right now. You can still request this title.';
              retry.hidden = false;
            }
          }
        };
        retry.addEventListener('click', () => { void showDetail(item, franchise, 0); });
        panel.append(preparationStatus, retry);
        if (refreshAttempt >= 5) {
          state.detailHydrationQueued.delete(item.anidbId);
          preparationStatus.textContent = 'Episode details are still unavailable. Try again later.';
          retry.hidden = false;
        } else if (state.detailHydrationQueued.has(item.anidbId)) {
          detailPollTimer = setTimeout(() => {
            void showDetail(item, franchise, refreshAttempt + 1);
          }, detailRefreshDelay(refreshAttempt));
        } else {
          void begin();
        }
      }
    } else {
      state.detailHydrationQueued.delete(item.anidbId);
    }
    const pager = data.state === 'detail_pending' ? null : createEpisodePager(data);
    if (pager) panel.append(element('p', `${data.kind === 'movie' ? 'Film' : 'Series'} · ${data.total} listed AniDB entr${data.total === 1 ? 'y' : 'ies'} · AniDB ${item.anidbId}`, 'detail-meta'));
    let refreshAvailabilitySummary = () => {};
    if (pager) {
      const savedCount = data.libraryPresence?.state === 'in_library' &&
        Number.isSafeInteger(data.libraryPresence.verifiedEpisodeCount) &&
        data.libraryPresence.verifiedEpisodeCount > 0
        ? data.libraryPresence.verifiedEpisodeCount : 0;
      const summary = element('p');
      refreshAvailabilitySummary = () => {
        const headline = titleAvailabilitySummary({ kind: data.kind,
          episodes: pager.episodes, nextPage: pager.nextPage,
          regularSeason: data.regularSeason,
          verifiedTitleItems: savedCount });
        summary.textContent = headline.text;
        summary.className = headline.available
          ? 'presence available' : 'presence unknown';
      };
      refreshAvailabilitySummary();
      panel.append(summary);
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
              refreshAvailabilitySummary();
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
    if (pager?.episodes.length === 0) panel.append(element('p',
      data.kind === 'movie'
        ? 'AniDB has no exact film entry listed yet. You can save a request; Negev will wait for an exact film entry before any download.'
        : 'AniDB has no episodes listed yet. An airing-series request can watch for future episodes.',
      'muted'));
    const family = franchise ?? createFranchiseExplorer({ anidbId: item.anidbId,
      title: data.title || item.title });
    const relatedButton = element('button', 'Show more related titles', 'text-link related-trigger');
    const relatedList = element('div', undefined, 'related-list');
    let installmentSelect = null;
    let selectedInstallmentId = item.anidbId;
    let updateRequestReview = () => {};
    const syncInstallmentChoice = () => {
      if (!installmentSelect) return;
      installmentSelect.replaceChildren();
      for (const entry of family.items()) {
        const option = element('option', entry.anidbId === item.anidbId
          ? `${entry.title} · this installment`
          : `${entry.title} · ${relationLabel(entry.relation)}`);
        option.value = String(entry.anidbId);
        installmentSelect.append(option);
      }
      installmentSelect.value = String(selectedInstallmentId);
    };
    const renderFamily = () => {
      relatedList.replaceChildren();
      const relationOrder = ['Prequel', 'Sequel', 'MainStory', 'SideStory',
        'Alternative', 'AlternativeVersion'];
      const installments = family.items().filter((entry) => entry.anidbId !== item.anidbId)
        .sort((a, b) => {
          const rank = (entry) => {
            const value = entry.relation?.replace(/[_\s-]/g, '').toLowerCase();
            const index = relationOrder.findIndex((relation) =>
              relation.toLowerCase() === value);
            return index < 0 ? relationOrder.length : index;
          };
          return rank(a) - rank(b);
        });
      if (installments.length === 0) relatedList.append(element('p',
        'No related anime links are available from the current metadata. Other installments may still exist; search by title to find them.', 'muted'));
      for (const installment of installments) {
        const open = element('button', undefined, 'related-card');
        const art = element('span', 'N', 'related-art poster-fallback');
        const image = posterImage(installment);
        image.addEventListener('load', () => art.classList.add('has-poster'));
        art.append(image);
        const copy = element('span', undefined, 'related-copy');
        copy.append(element('small', relationLabel(installment.relation),
          'related-relation'));
        copy.append(element('strong', installment.title));
        const count = installment.libraryPresence?.state === 'in_library'
          ? installment.libraryPresence.verifiedEpisodeCount : 0;
        if (count > 0) copy.append(element('span',
          `${count} verified item${count === 1 ? '' : 's'} in library`,
          'related-presence'));
        open.append(art, copy);
        open.addEventListener('click', () => {
          state.searchItems.set(installment.anidbId, installment);
          location.hash = titleRoute(installment.anidbId);
        });
        relatedList.append(open);
      }
      relatedButton.textContent = family.next() ? 'Show more related titles' :
        'No more cached links to explore';
      relatedButton.hidden = !family.next();
      relatedButton.disabled = !family.next();
      syncInstallmentChoice();
    };
    if (franchise) renderFamily();
    else {
      relatedList.append(element('p', 'Finding related titles…', 'muted'));
      relatedButton.textContent = 'Finding related titles…';
      relatedButton.disabled = true;
    }
    let relatedLoading = false;
    const loadRelated = async ({ batch = false } = {}) => {
      const next = family.next();
      if (!next || relatedLoading) return;
      relatedLoading = true;
      relatedButton.disabled = true;
      relatedButton.textContent = 'Loading related titles…';
      try {
        const result = await expandFranchiseBatch({ explorer: family,
          read: (anidbId) => api(`/api/catalogue/${anidbId}/related`),
          maxReads: batch ? 8 : 1, minNewItems: batch ? 8 : 1,
          shouldContinue: isCurrentDetail });
        if (isCurrentDetail()) {
          renderFamily();
          if (result.failures === 0) return;
          const error = element('p',
            result.state === 'root_unavailable'
              ? 'Related titles could not be loaded. Try again or search for another installment.'
              : 'Some relationships could not be loaded. You can open that title directly or continue exploring.',
            'muted related-error');
          if (relatedList.querySelector('.related-card')) {
            relatedList.querySelector('.related-error')?.remove();
            relatedList.append(error);
          } else relatedList.replaceChildren(error);
          if (family.next()) {
            relatedButton.textContent = result.state === 'root_unavailable' ?
              'Try related titles again' : 'Show more related titles';
            relatedButton.hidden = false;
            relatedButton.disabled = false;
          }
        }
      } finally { relatedLoading = false; }
    };
    relatedButton.addEventListener('click', () => { void loadRelated({ batch: true }); });
    const relatedHeading = element('h2', 'Related titles', 'related-heading');
    panel.append(relatedHeading, relatedList, relatedButton);
    if (!franchise) void loadRelated();
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
    if (pager.episodes.length > 0) {
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
      const optionText = (episode) =>
        `${episode.type === 'Episode' ? 'Episode' : episode.type} ${episode.number}` +
        `${episode.title ? ` · ${episode.title}` : ''}` +
        `${episode.availability === 'available' ?
          episode.availabilityNote === 'alternate_card'
            ? ' · Playable in Plex; episode card not linked to this episode'
            : ' · Playable in Plex' :
          episode.availability === 'previously_available'
            ? ' · Previously playable; recheck needed' : ''}`;
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
      const button = element('button', 'Check availability');
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
          updateOption(Number(select.value), status.state, status.presentation);
          select.dispatchEvent(new Event('change'));
          result.textContent = status.state === 'available' ?
            status.presentation === 'alternate_card'
              ? 'Playable in Plex; episode card not linked to this episode'
              : 'Playable in Plex' : 'Availability is not confirmed yet';
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
            episode?.availability === 'available';
          requestSelected.textContent = episode?.type === 'Special'
            ? 'Request this Special' : 'Request this episode';
        };
        select.addEventListener('change', updateSelection);
        updateSelection();
        requestSelected.addEventListener('click', async () => {
          if (requesting) return;
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          if (!['Episode', 'Special'].includes(episode?.type) ||
              episode.availability === 'available') return;
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
      if (pendingFilmAction) panel.insertBefore(pendingFilmAction, relatedHeading);
      return;
    }
    // Keep the original control mounted while its save is in flight so the
    // asynchronous result and request number remain visible after hydration.
    if (earlyRequest?.dataset.saving === 'true' ||
        earlyRequest?.dataset.saved === 'true') {
      panel.insertBefore(earlyRequest, relatedHeading);
      return;
    }
    const requestAction = element('section', undefined, 'request-action');
    requestAction.append(element('h2', 'Request this installment'));
    requestAction.append(element('p', data.kind === 'movie'
      ? 'A film request includes one main film entry, not extras or trailers.'
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
          selectedInstallmentId = selectedId;
          requestStatus.textContent = '';
          updateRequestReview();
          refreshRequestAction();
        }
      });
      installmentLabel.append(installmentSelect);
      requestAction.append(installmentLabel);
      syncInstallmentChoice();
    }
    panel.insertBefore(requestAction, relatedHeading);
    const requestStatus = element('p', '', 'muted request-feedback');
    requestStatus.setAttribute('role', 'status');
    const alreadyAvailable = () => selectedInstallmentId === item.anidbId &&
      installmentRequestState({ kind: data.kind,
      episodes: pager.episodes, nextPage: pager.nextPage,
      monitorFuture: data.monitorFuture,
      regularSeason: data.regularSeason }) === 'already_available';
    const requestLabel = () => data.kind === 'movie' ? 'Request film' :
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
      const checkingSelected = selectedInstallmentId === item.anidbId &&
        checkingCompleteSeries;
      button.disabled = blocked || checkingSelected;
      button.textContent = blocked ? 'Already available' :
        checkingSelected ? 'Checking availability…' :
          reviewingRequest ? 'Confirm request' : requestLabel();
      if (blocked) requestStatus.textContent = 'This installment is already verified in Negev’s Library.';
      else if (requestStatus.textContent === 'This installment is already verified in Negev’s Library.') {
        requestStatus.textContent = '';
      }
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
      requestAction.append(filmChoice);
    }
    button.addEventListener('click', async () => {
      if (alreadyAvailable() || requestSaving || requestSaved) return;
      if (needsFilmChoice && !filmChoiceSelect.value) {
        filmChoice.hidden = false;
        button.textContent = 'Request selected film';
        requestStatus.textContent = 'Choose one main film entry above.';
        filmChoiceSelect.focus();
        return;
      }
      if (!reviewingRequest) {
        reviewingRequest = true;
        requestReview.hidden = false;
        button.textContent = 'Confirm request';
        requestStatus.textContent = 'Review this installment, then confirm.';
        return;
      }
      requestSaving = true;
      if (installmentSelect) installmentSelect.disabled = true;
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
        }) });
        requestKeys.saved(scope);
        requestSaved = true;
        reviewingRequest = false;
        requestReview.hidden = true;
        button.textContent = 'Requested';
        requestStatus.textContent = savedRequestMessage(saved);
        message(saved.state === 'pending'
          ? 'Request saved. Follow it under My Requests.'
          : `Request #${saved.requestId} saved. ${currentAcquisitionNotice()}`);
        loadRequests();
      } catch (error) {
        const feedback = requestFailureMessage(error);
        requestStatus.textContent = feedback;
        message(feedback, true);
        requestSaving = false;
        if (installmentSelect) installmentSelect.disabled = false;
        refreshRequestAction();
      }
    });
    requestAction.append(requestReview, button, requestStatus);
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
    panel.replaceChildren(loadingArt, element('h1', item.title, 'detail-title'),
      displaySummary, unavailable, retry);
    const pendingAction = earlyRequest;
    if (pendingAction) panel.append(pendingAction);
    void displayRead.then((display) => renderDisplay(display, item.title));
  }
}
void refreshSession();
