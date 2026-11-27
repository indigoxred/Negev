import { trackingAction } from './airing-tracking-controls.mjs';
import { titleRoute } from './consumer-route.mjs';

// Owns tracking preference serialization, controls and tracked title rendering. Construction does not register event handlers.
export function createTrackingController({ api, applyAdultVisibility, byId, element, loadAiring, markAdult, message, sessionResponses, state, document = globalThis.document }) {
  let trackingPrefsPromise = null;

  let trackingSaving = false;

  let trackingPreferencesRevision = 0;

  let trackingMutationTail = Promise.resolve();

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

  const handleViewModeChange = async (event) => {
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
  };
  return { updateTrackControls, ensureTrackingPreferences, changeTrackingPreferences, refreshTrackingAfterRequest, makeTrackButton, trackedCard, renderTrackedTitles, handleViewModeChange, resetTracking() { trackingPrefsPromise = null; trackingPreferencesRevision++; trackingMutationTail = Promise.resolve(); trackingSaving = false; } };
}
