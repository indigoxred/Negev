// Owns session transitions and signed-out workspace reset. Construction does not register event handlers.
export function createSessionController({
  admin,
  airingResponses,
  airingSeasonResponses,
  api,
  applyAdultVisibility,
  applyPendingLinkCode,
  applyTitlePreference,
  auth,
  browse,
  byId,
  currentAcquisitionNotice,
  detail,
  dismissRequestDialogs,
  displayCache,
  element,
  ensureTrackingPreferences,
  genreSelections,
  invalidateRequestResponses,
  libraryResponses,
  loadOperationalReview,
  loadRequests,
  message,
  readAdultPreference,
  readChinesePreference,
  readEnglishTitlePreference,
  renderRoute,
  renderTrackedTitles,
  resetRoutePosition,
  reviewResponses,
  seasonalResponses,
  sessionResponses,
  state,
  stopBrowsePageObserver,
  stopLibraryPageObserver,
  tracking,
  updateRequestScopeButtons,
  history = globalThis.history,
  document = globalThis.document,
  now = Date.now
}) {
  let refreshing = null;
  let lastSessionCheckMs = -Infinity;
  function applyCapabilities(data) {
    state.csrf = data.csrfToken;
    state.releaseSearch = data.capabilities?.releaseSearch === true;
    state.detailLoad = data.capabilities?.detailLoad === true;
    state.titleChecks = data.capabilities?.titleChecks === true;
    state.acquisitionState = data.capabilities?.acquisitionState || 'disabled';
    byId('service-notice').textContent = data.capabilities?.availabilityChecks === true
      ? `Negev is in preview. ${currentAcquisitionNotice()} Public Plex availability can be checked; an unconfirmed result does not mean a file is missing.`
      : `Negev is in preview. ${currentAcquisitionNotice()} Public Plex checks are not active.`;
  }
  function showSession(data) {
    if (state.user?.id !== data.user.id ||
        state.user?.adultAllowed !== data.user.adultAllowed ||
        state.user?.role !== data.user.role) {
      dismissRequestDialogs();
      sessionResponses.invalidate();
      invalidateRequestResponses();
      reviewResponses.invalidate();
      detail.invalidate();
      stopLibraryPageObserver();
      stopBrowsePageObserver('discover');
      stopBrowsePageObserver('airing');
      libraryResponses.invalidate();
      airingResponses.invalidate();
      airingSeasonResponses.invalidate();
      seasonalResponses.invalidate();
      state.selected = null;
      state.searchToken++;
      state.searchItems.clear();
      state.lastSearchQuery = '';
      state.detailHydrationQueued.clear();
      displayCache.clear();
      byId('results').replaceChildren();
      byId('library-search-results').replaceChildren();
      for (const id of ['library-list', 'season-list', 'airing-list', 'airing-season-list']) {
        byId(id).replaceChildren();
      }
      byId('request-list').replaceChildren();
      byId('preparing-list').replaceChildren();
      byId('more-preparations').hidden = true;
      byId('watch-list').replaceChildren();
      byId('review-list').replaceChildren();
      byId('detail').replaceChildren(element('p',
        'Select a result to see its details.', 'muted'));
      state.nextBeforeId = { watching: null, history: null, preparing: null };
      state.requestHistoryExpanded = false;
      state.usersLoaded = false;
      state.requestScope = data.user.role === 'admin' ? 'all' : 'mine';
      state.libraryLoaded = false;
      state.libraryAfter = null;
      state.airingLoaded = false;
      state.airingPreferences = null;
      tracking.resetTracking();
      byId('airing-view-mode').disabled = false;
      browse.setAiringFilters({ year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' });
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
    applyCapabilities(data);
    byId('auth').hidden = true;
    byId('session-loading').hidden = true;
    byId('workspace').hidden = false;
    if (auth.pendingLink) {
      message(auth.pendingLink.kind === 'invite'
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
    resetRoutePosition();
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
    detail.invalidate();
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
    tracking.resetTracking();
    byId('airing-view-mode').disabled = false;
    browse.setAiringFilters({ year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' });
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

  async function readSession({ background = false } = {}) {
    const started = sessionResponses.current();
    try {
      const data = await api('/api/session');
      if (!sessionResponses.isCurrent(started)) return;
      lastSessionCheckMs = now();
      if (background && state.user?.id === data.user.id &&
          state.user.adultAllowed === data.user.adultAllowed &&
          state.user.role === data.user.role) {
        applyCapabilities(data);
        return true;
      }
      showSession(data);
      loadRequests();
      if (data.user.role === 'admin') void loadOperationalReview();
      return true;
    } catch (error) {
      if (!sessionResponses.isCurrent(started)) return false;
      if ([401, 403].includes(error?.status)) {
        clearWorkspace();
        applyPendingLinkCode();
      } else if (!background) {
        byId('session-loading-text').textContent =
          'Could not check your session.';
        byId('session-retry').hidden = false;
        byId('session-loading').hidden = false;
        message('Could not check your session. Retry the session check.', true);
      }
      return false;
    }
  }
  function refreshSession(options) {
    const generation = sessionResponses.current();
    if (refreshing?.generation === generation) return refreshing.promise;
    const active = { generation };
    active.promise = readSession(options).finally(() => {
      if (refreshing === active) refreshing = null;
    });
    refreshing = active;
    return active.promise;
  }
  function refreshVisibleSession() {
    if (!state.user || document?.hidden || now() - lastSessionCheckMs < 60_000) return;
    // Failed checks also wait for the next interval rather than retrying on
    // every focus event while the server is unavailable.
    lastSessionCheckMs = now();
    return refreshSession({ background: true });
  }
  return { showSession, clearWorkspace, refreshSession, refreshVisibleSession };
}
