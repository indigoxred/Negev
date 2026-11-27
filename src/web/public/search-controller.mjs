import { createSearchPager } from './search-pages.mjs';
import { createAdultSearchVerifier } from './adult-search-visibility.mjs';
import { hideChineseProduction } from './chinese-visibility.mjs';
import { parseConsumerRoute, searchRoute, librarySearchRoute } from './consumer-route.mjs';

// Owns search requests, response classification and session-scoped metadata hydration. Construction does not register event handlers.
export function createSearchController({ verifier, api, applyAdultVisibility, byId, element, message, restoreRoutePosition, searchResultCard, sessionResponses, state, document = globalThis.document, location = globalThis.location }) {
  let classificationToken = 0;

  const adultSearchVerifier = verifier ?? createAdultSearchVerifier({ readDisplay: (id) =>
    api(`/api/catalogue/${id}/display`, { cache: 'no-store',
      signal: AbortSignal.timeout(30_000) }) });

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
    await adultSearchVerifier.verify(ids, (id, adult, display) => {
      if (!current()) return;
      const item = state.searchItems.get(id);
      const entry = item && { ...item, ...(!item.title ? display : {}), adult };
      if (entry) state.searchItems.set(id, entry);
      for (const node of document.querySelectorAll('#results [data-anidb-id], #library-search-results [data-anidb-id]')) {
        if (Number(node.dataset.anidbId) === id) {
          if (!item?.title && entry?.title) {
            node.replaceWith(searchResultCard(entry,
              Boolean(node.closest('#library-search-results'))));
            continue;
          }
          node.dataset.adult = String(adult);
          if (adult && !node.querySelector('.adult-label')) {
            node.querySelector('.result-copy')?.append(
              element('span', '18+', 'badge partial adult-label'));
          }
        }
      }
      applyAdultVisibility();
    }, { current, session,
      refreshMetadata: ids.some(id => !state.searchItems.get(id)?.title) });
  }

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

  const handleSearchSubmit = async (event) => {
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
        const entry = { ...item, adult: item.title ? item.adult ?? known?.adult : undefined };
        state.searchItems.set(item.anidbId, entry);
        results.append(searchResultCard(entry, inLibrary));
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
  };
  return { classifySearchCards, submitInlineSearch, handleSearchSubmit, invalidate() { classificationToken++; } };
}
