import { createRequestKeyStore } from './request-key.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { createSearchPager } from './search-pages.mjs';
import { requestPresentation } from './request-progress-text.mjs';
import { createResponseEpoch } from './response-epoch.mjs';
import { createFranchiseExplorer } from './franchise-explorer.mjs';
import { acquisitionNotice } from './acquisition-notice.mjs';
import { summarizeSeasonAvailability, summarizeFilmAvailability,
  installmentRequestState } from './season-availability-presentation.mjs';
import { detailRefreshDelay } from './detail-refresh.mjs';
import { relationLabel } from './relation-label.mjs';
import { parseConsumerRoute, searchRoute, titleRoute,
  seasonRoute } from './consumer-route.mjs';

const byId = (id) => document.getElementById(id);
const requestKeys = createRequestKeyStore({ storage: sessionStorage,
  createKey: () => crypto.randomUUID() });
const state = { csrf: null, user: null, selected: null,
  nextBeforeId: { watching: null, history: null }, releaseSearch: false, detailLoad: false,
  titleChecks: false, acquisitionState: 'disabled', searchToken: 0,
  lastSearchQuery: '', searchItems: new Map(),
  libraryLoaded: false, libraryAfter: null, airingLoaded: false,
  seasonalRouteKey: null, routePage: null,
  requestHistoryExpanded: false,
  showAdult: true, usersLoaded: false,
  detailHydrationQueued: new Set() };
const sessionResponses = createResponseEpoch();
const requestResponses = {
  watching: createResponseEpoch(), history: createResponseEpoch(),
};
const displayCache = new Map();
function invalidateRequestResponses() {
  requestResponses.watching.invalidate();
  requestResponses.history.invalidate();
}
const reviewResponses = createResponseEpoch();
const detailResponses = createResponseEpoch();
const libraryResponses = createResponseEpoch();
const airingResponses = createResponseEpoch();
const seasonalResponses = createResponseEpoch();
let nextReviewAttemptId = null;
let detailPollTimer = null;
const genreSelections = { season: new Set(), airing: new Set() };
let airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'newest' };
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
function markAdult(node, item) {
  node.dataset.anidbId = String(item.anidbId);
  node.dataset.adult = item.adult === true ? 'true' :
    item.adult === false ? 'false' : 'unknown';
  node.hidden = !state.showAdult && item.adult === true;
  return node;
}
function applyAdultVisibility() {
  for (const node of document.querySelectorAll('[data-anidb-id]')) {
    node.hidden = !state.showAdult && (node.dataset.adult === 'true' ||
      state.searchItems.get(Number(node.dataset.anidbId))?.adult === true);
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
  for (const name of ['discover', 'airing', 'library', 'requests', 'title', 'admin']) {
    byId(`view-${name}`).hidden = name !== page;
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `Negev · ${page[0].toUpperCase()}${page.slice(1)}`;
  if (page === 'title') {
    byId('back-to-discover').href = searchRoute(state.lastSearchQuery);
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
    byId('watch-list').replaceChildren();
    byId('review-list').replaceChildren();
    byId('detail').replaceChildren(element('p',
      'Select a result to see its details.', 'muted'));
    state.nextBeforeId = { watching: null, history: null };
    state.requestHistoryExpanded = false;
    state.libraryLoaded = false;
    state.libraryAfter = null;
    state.airingLoaded = false;
    airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'newest' };
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
  state.searchItems.clear();
  state.libraryLoaded = false;
  state.libraryAfter = null;
  state.airingLoaded = false;
  airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'newest' };
  genreSelections.airing.clear();
  genreSelections.season.clear();
  state.seasonalRouteKey = null;
  state.routePage = null;
  state.nextBeforeId = { watching: null, history: null };
  state.requestHistoryExpanded = false;
  nextReviewAttemptId = null;
  state.releaseSearch = false;
  state.detailLoad = false;
  state.titleChecks = false;
  state.acquisitionState = 'disabled';
  byId('service-notice').textContent =
    'Negev is in preview. Sign in to see acquisition status.';
  byId('request-list').replaceChildren();
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
  void loadRequestView('watching', false, silent);
  void loadRequestView('history', false, silent);
}
function refreshVisibleRequests() {
  if (!state.user || state.routePage !== 'requests') return;
  refreshRequestStatusAges();
  if (document.hidden) return;
  if (state.requestHistoryExpanded) {
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
    choices.replaceChildren();
    for (const tag of matching.slice(0, 40)) {
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
      choices.append(label);
    }
    byId(`${prefix}-tag-count`).textContent = matching.length > 40
      ? `Showing 40 of ${matching.length} matches. Search to narrow; select up to five.`
      : `${matching.length} matching genres and themes. Select up to five.`;
    byId(`${prefix}-form`).querySelector('.genre-picker summary').textContent =
      `Genres & themes · ${genreSelections[prefix].size || 'All'}`;
  };
  search.value = '';
  search.oninput = render;
  search.onkeydown = (event) => { if (event.key === 'Enter') event.preventDefault(); };
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
  byId('season-previous').hidden = true;
  byId('season-next').hidden = true;
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
    previous.hidden = after === 0;
    previous.onclick = () => { location.hash = seasonRoute(year, season,
      Math.max(0, after - 12), { kind, tag }); };
    const next = byId('season-next');
    next.hidden = page.nextAfter === null;
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
    notice.textContent = page.state === 'stale'
      ? 'Showing a saved ongoing-title list; release status may have changed.'
      : 'Titles AniMap currently marks ongoing. Popularity is not ranked here.';
    for (const item of page.items ?? []) {
      const count = item.libraryPresence?.verifiedEpisodeCount ?? 0;
      const available = item.libraryPresence?.state === 'in_library' && count > 0;
      list.append(discoveryCard(item, item.type || 'Anime', available
        ? `✓ In library · ${count} verified ${count === 1 ? 'item' : 'items'}`
        : 'Availability not checked', available));
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
      !['newest', 'oldest', 'title_asc', 'title_desc'].includes(sort)) return;
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
      copy.append(element('strong', item.title),
        element('small', `Episode ${item.episodeNumber} · scheduled ${item.scheduledDate}`),
        element('span', 'Local availability not checked', 'presence unknown'));
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
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('refresh-library').addEventListener('click', () => { void loadLibrary(); });
byId('more-requests').addEventListener('click', () => { void loadRequestView('history', true); });
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
  if (parseConsumerRoute(location.hash).page === 'title' && state.selected) {
    const item = state.searchItems.get(state.selected) ??
      { anidbId: state.selected, title: `Anime ${state.selected}` };
    void showDetail(item);
  }
});
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
      const button = markAdult(element('button', undefined, 'result'), entry);
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
      button.append(tile, copy);
      button.addEventListener('click', () => { location.hash = titleRoute(item.anidbId); });
      results.append(button);
    }
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
async function showDetail(item, franchise = null, refreshAttempt = 0) {
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
  let displayRead = displayCache.get(item.anidbId);
  if (!displayRead) {
    displayRead = api(`/api/catalogue/${item.anidbId}/display`)
      .catch(() => null);
    displayCache.set(item.anidbId, displayRead);
    if (displayCache.size > 100) displayCache.delete(displayCache.keys().next().value);
  }
  const renderDisplay = (display, title) => {
    if (!isCurrentDetail() || display?.state !== 'display') return;
    displaySummary.replaceChildren();
    const facts = [display.type, display.startYear].filter(Boolean).join(' · ');
    if (facts) displaySummary.append(element('p', facts, 'detail-facts'));
    if (display.englishTitle && display.englishTitle !== title) {
      displaySummary.append(element('p', `Also known as ${display.englishTitle}`,
        'detail-alias'));
    }
    if (display.description) displaySummary.append(element('p',
      display.description, 'detail-description'));
    const quickFacts = element('dl', undefined, 'detail-quickfacts');
    for (const [label, value] of [
      ['Format', display.type], ['First aired', display.startDate],
      ['Last aired', display.endDate],
      ['Listed episodes', display.episodeCount],
    ]) {
      if (value === null || value === undefined || value === '') continue;
      const fact = element('div');
      fact.append(element('dt', label), element('dd', String(value)));
      quickFacts.append(fact);
    }
    if (quickFacts.childElementCount) displaySummary.append(quickFacts);
    if (display.tags?.length) {
      const tags = element('div', undefined, 'detail-tags');
      for (const tag of display.tags) tags.append(element('span', tag));
      displaySummary.append(tags);
    }
  };
  if (state.showAdult && state.user?.adultAllowed !== false) {
    void displayRead.then((display) => renderDisplay(display, item.title));
  }
  try {
    const data = await api(`/api/catalogue/${item.anidbId}`);
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
    panel.append(displaySummary);
    if (typeof data.plexUrl === 'string' &&
        /^https:\/\/app\.plex\.tv\/desktop\/#\!\/server\/[a-f0-9]{40}\/details\?key=%2Flibrary%2Fmetadata%2F[1-9][0-9]*$/i
          .test(data.plexUrl)) {
      const openPlex = element('a', 'Open in Plex', 'text-link');
      openPlex.href = data.plexUrl;
      openPlex.target = '_blank';
      openPlex.rel = 'noopener noreferrer';
      openPlex.dataset.plexLink = '';
      panel.append(openPlex);
    }
    void displayRead.then((display) => renderDisplay(display, data.title || item.title));
    if (data.state === 'detail_pending') {
      if (!state.detailLoad) {
        panel.append(element('p', 'Episode details are not cached yet. Detail loading is disabled in this preview, so this title cannot be requested.', 'muted'));
      } else {
        panel.append(element('p', 'Preparing episode details automatically. You can keep browsing; this page will update when they are ready.', 'muted'));
      }
      if (state.detailLoad) {
        const retry = element('button', 'Retry loading details');
        retry.hidden = true;
        const begin = async () => {
          state.detailHydrationQueued.add(item.anidbId);
          retry.hidden = true;
          try {
            const hydration = await api(`/api/catalogue/${item.anidbId}/load-detail`,
              { method: 'POST', body: '{}' });
            if (isCurrentDetail()) {
              if (hydration.state === 'detail_ready') void showDetail(item, franchise);
              else detailPollTimer = setTimeout(() => {
                void showDetail(item, franchise, 1);
              }, detailRefreshDelay(0));
            }
          } catch (error) {
            state.detailHydrationQueued.delete(item.anidbId);
            if (isCurrentDetail()) {
              message(error.message, true);
              retry.hidden = false;
            }
          }
        };
        retry.addEventListener('click', () => { void begin(); });
        panel.append(retry);
        if (state.detailHydrationQueued.has(item.anidbId)) {
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
    if (pager) {
      const season = summarizeSeasonAvailability({ kind: data.kind,
        episodes: pager.episodes, nextPage: pager.nextPage });
      const film = summarizeFilmAvailability({ kind: data.kind,
        episodes: pager.episodes, nextPage: pager.nextPage });
      const savedCount = data.libraryPresence?.state === 'in_library' &&
        Number.isSafeInteger(data.libraryPresence.verifiedEpisodeCount) &&
        data.libraryPresence.verifiedEpisodeCount > 0
        ? data.libraryPresence.verifiedEpisodeCount : 0;
      const pageCount = pager.episodes.filter((episode) =>
        episode.availability === 'available').length;
      const verified = Math.max(savedCount, pageCount);
      panel.append(element('p', film?.available
        ? `Available in Plex · ${film.verified} verified main film entr${film.verified === 1 ? 'y' : 'ies'}. Other editions and extras are separate.`
        : film && film.total > 0
          ? 'No main film entry is currently verified playable in Plex. This does not establish that it is missing.'
        : season?.completeList && season.total > 0
        ? `${season.verified} of ${season.total} regular episodes verified playable in Plex. Specials are separate.`
        : season && season.total > 0
          ? `${season.verified} regular episodes on this page verified playable in Plex. More episodes remain to load.`
        : verified > 0
        ? `${verified} ${data.kind === 'movie'
          ? `film entr${verified === 1 ? 'y' : 'ies'}`
          : `episode${verified === 1 ? '' : 's'}`} verified playable in Plex for this title. Other entries are not confirmed.`
        : 'Current Plex availability has not been verified for this title.',
      film?.available || season?.verified > 0 ||
        (!film && verified > 0) ? 'presence available' : 'presence unknown'));
    }
    if (pager?.episodes.length === 0) panel.append(element('p',
      data.kind === 'movie'
        ? 'AniDB has no film target listed yet, so this film cannot be requested.'
        : 'AniDB has no episodes listed yet. An airing-series request can watch for future episodes.',
      'muted'));
    const family = franchise ?? createFranchiseExplorer({ anidbId: item.anidbId,
      title: data.title || item.title });
    const relatedButton = element('button', 'Explore franchise', 'text-link related-trigger');
    const relatedList = element('div', undefined, 'related-list');
    let installmentSelect = null;
    const syncInstallmentChoice = () => {
      if (!installmentSelect) return;
      installmentSelect.replaceChildren();
      for (const entry of family.items()) {
        const option = element('option', entry.anidbId === item.anidbId
          ? `${entry.title} · this installment` : entry.title);
        option.value = String(entry.anidbId);
        installmentSelect.append(option);
      }
      installmentSelect.value = String(item.anidbId);
    };
    const renderFamily = () => {
      relatedList.replaceChildren(element('p',
        family.status().state === 'no_cached_links'
          ? 'No related anime links are available from the current metadata. Other installments may still exist; search by title to find them.'
          : 'Related AniDB titles. Other installments may exist; each title has its own request.',
        'muted'));
      for (const installment of family.items().filter((entry) => entry.anidbId !== item.anidbId)) {
        const open = element('button', undefined, 'related-card');
        open.disabled = installment.anidbId === item.anidbId;
        const art = element('span', 'N', 'related-art poster-fallback');
        const image = posterImage(installment);
        image.addEventListener('load', () => art.classList.add('has-poster'));
        art.append(image);
        const copy = element('span', undefined, 'related-copy');
        copy.append(element('small', relationLabel(installment.relation)),
          element('strong', installment.title));
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
      relatedButton.textContent = family.next() ? 'Explore next related title' :
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
    const loadRelated = async () => {
      const next = family.next();
      if (!next || relatedLoading) return;
      relatedLoading = true;
      relatedButton.disabled = true;
      try {
        const related = await api(`/api/catalogue/${next.anidbId}/related`);
        family.add(related);
        if (isCurrentDetail()) renderFamily();
      } catch {
        if (isCurrentDetail()) {
          const error = element('p',
            'Related titles could not be loaded now. You can still search for another installment by name.',
            'muted related-error');
          if (relatedList.querySelector('.related-card')) {
            relatedList.querySelector('.related-error')?.remove();
            relatedList.append(error);
          } else relatedList.replaceChildren(error);
          relatedButton.textContent = 'Try related titles again';
          relatedButton.disabled = false;
        }
      } finally { relatedLoading = false; }
    };
    relatedButton.addEventListener('click', () => { void loadRelated(); });
    const relatedHeading = element('h2', 'Related titles', 'related-heading');
    panel.append(relatedHeading, relatedList, relatedButton);
    if (!franchise) void loadRelated();
    if (!pager) return;
    let filmChoiceSelect = null;
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
        const filmAlreadyAvailable = summarizeFilmAvailability({ kind: data.kind,
          episodes: pager.episodes, nextPage: pager.nextPage })?.available === true;
        const updateSelection = () => {
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          requestSelected.disabled = requesting || episode?.type !== 'Episode' ||
            episode.availability === 'available' || filmAlreadyAvailable;
        };
        select.addEventListener('change', updateSelection);
        updateSelection();
        requestSelected.addEventListener('click', async () => {
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          if (requesting || filmAlreadyAvailable || episode?.type !== 'Episode' ||
              episode.availability === 'available') return;
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
        more.addEventListener('click', async () => {
          more.disabled = true;
          try {
            const page = await api(`/api/catalogue/${item.anidbId}?page=${pager.nextPage}`);
            if (!isCurrentDetail()) return;
            const added = pager.append(page);
            if (added.state !== 'appended') throw new Error('Episode list changed; select the title again');
            appendOptions(added.episodes);
            if (pager.nextPage === null) more.remove();
            else more.disabled = false;
          } catch (error) { message(error.message, true); more.disabled = false; }
        });
        advanced.append(more);
      }
    }
    if (typeof data.restricted !== 'boolean') {
      panel.append(element('p',
        'This title is not requestable until its catalogue status is verified.', 'muted'));
      return;
    }
    if (data.restricted) panel.append(element('p', '18+ title', 'badge partial'));
    if (data.kind === 'movie' && pager.episodes.length === 0) return;
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
        if (selectedId !== item.anidbId && Number.isSafeInteger(selectedId)) {
          const selected = family.items().find((entry) => entry.anidbId === selectedId);
          if (selected) {
            state.searchItems.set(selectedId, selected);
            location.hash = titleRoute(selectedId);
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
    const alreadyAvailable = installmentRequestState({ kind: data.kind,
      episodes: pager.episodes, nextPage: pager.nextPage,
      monitorFuture: data.monitorFuture }) === 'already_available';
    const requestLabel = data.kind === 'movie' ? 'Request film' :
      data.monitorFuture === true && pager.episodes.some((episode) =>
        episode.type === 'Episode' && episode.availability === 'available')
        ? 'Watch future episodes' : 'Request series';
    const button = element('button', requestLabel, 'primary');
    if (alreadyAvailable) {
      button.disabled = true;
      button.textContent = 'Already available';
      requestStatus.textContent = 'This installment is already verified in Negev’s Library.';
    }
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
      if (alreadyAvailable) return;
      if (needsFilmChoice && !filmChoiceSelect.value) {
        filmChoice.hidden = false;
        button.textContent = 'Request selected film';
        requestStatus.textContent = 'Choose one main film entry above.';
        filmChoiceSelect.focus();
        return;
      }
      button.disabled = true;
      button.textContent = 'Saving request…';
      requestStatus.textContent = 'Saving your request…';
      const selectedFilmId = needsFilmChoice ? Number(filmChoiceSelect.value) : null;
      const scope = { userId: state.user.id, anidbId: item.anidbId,
        ...(selectedFilmId ? { selection: `film-entry-${selectedFilmId}` } : {}) };
      const requestKey = requestKeys.pending(scope);
      try {
        const saved = await api('/api/requests', { method: 'POST', body: JSON.stringify({
          anidbId: item.anidbId,
          scope: selectedFilmId ? 'episodes' : 'installment',
          ...(selectedFilmId ? { episodeIds: [selectedFilmId] } : {}), requestKey,
        }) });
        requestKeys.saved(scope);
        button.textContent = 'Requested';
        requestStatus.textContent = `Request #${saved.requestId} saved. View its progress under My Requests.`;
        message(`Request #${saved.requestId} saved. ${currentAcquisitionNotice()}`);
        loadRequests();
      } catch (error) {
        requestStatus.textContent = error.message;
        message(error.message, true);
        button.textContent = requestLabel;
        button.disabled = false;
      }
    });
    requestAction.append(button, requestStatus);
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
    if (state.showAdult && state.user?.adultAllowed !== false) {
      void displayRead.then((display) => renderDisplay(display, item.title));
    }
  }
}
void refreshSession();
