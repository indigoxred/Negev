import { catalogueAvailability } from './card-availability.mjs';
import { observeCatalogueContinuation, createCataloguePrefetchBudget } from './search-pages.mjs';
import { parseConsumerRoute, titleRoute, seasonRoute } from './consumer-route.mjs';

// Owns catalogue browse pages, filters, continuation observers and pacing budgets. Construction does not register event handlers.
export function createBrowseController({
  airingResponses,
  airingSeasonResponses,
  api,
  byId,
  element,
  ensureTrackingPreferences,
  genreSelections,
  libraryResponses,
  markAdult,
  posterImage,
  renderTrackedTitles,
  restoreRoutePosition,
  seasonalResponses,
  sessionResponses,
  state,
  titleLabel,
  trackedCard,
  document = globalThis.document,
  window = globalThis.window,
  location = globalThis.location,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout
}) {
  let airingFilters = { year: 0, season: 'ALL', kind: 'all', tag: '', sort: 'popular_desc' };

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

  const handleSeasonSubmit = (event) => {
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
  };

  const handleSeasonSort = () =>
    byId('season-form').requestSubmit();

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

  const handleAiringSubmit = (event) => {
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
  };

  const handleAiringSort = () =>
    byId('airing-form').requestSubmit();

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

  const handleFilterRouteChange = () => {
    for (const prefix of Object.keys(filterApplyTimers)) {
      clearTimeout(filterApplyTimers[prefix]);
      delete filterApplyTimers[prefix];
    }
  };

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

  const handleLibraryRefresh = () => {
    if (parseConsumerRoute(location.hash).query) {
      location.hash = '#/library';
      return;
    }
    void loadLibrary();
  };
  return { loadLibrary, loadSeasonal, loadAiring, loadCurrentAiring, seasonChoice, stopLibraryPageObserver, stopBrowsePageObserver, publicPresenceBadge, scheduleFilterApply, handleSeasonSubmit, handleSeasonSort, handleAiringSubmit, handleAiringSort, handleFilterRouteChange, handleLibraryRefresh, setAiringFilters(value) { airingFilters = value; } };
}
