import { makeReleaseActions } from './release-dialog.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';
import { createResponseEpoch } from './response-epoch.mjs';
import { createFranchiseExplorer, createRelatedDetailCache, expandFranchiseBatch,
  groupFranchiseItems } from './franchise-explorer.mjs';
import { titleAvailabilitySummary,
  installmentRequestState, filmEntryRequestState } from './season-availability-presentation.mjs';
import { episodeScheduleLabel, nextAirDateLabel } from './episode-schedule.mjs';
import { canOpenSeasonRequest, relatedAvailabilityText, seasonRequestStatus,
  seasonSelectionSummary, seasonSelectionScope, seasonTriggerPresentation } from './season-request-selection.mjs';
import { relationLabel } from './relation-label.mjs';
import { detailOriginalTitle, detailAliasText } from './title-preference.mjs';
import { titleRoute, requestRoute } from './consumer-route.mjs';

// Owns detail response epochs, polling, and title request actions. Construction does not register event handlers.
export function createDetailController({ api, applyAdultVisibility, byId, currentAcquisitionNotice, displayCache, element, loadRequests, makeTrackButton, message, openPreviewReleaseRequests, openSavedReleaseRequests, posterImage, preferredDisplayTitle, refreshTrackingAfterRequest, requestKeys, sessionResponses, state, titleLabel, updateTrackControls, document = globalThis.document, location = globalThis.location, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, requestAnimationFrame = globalThis.requestAnimationFrame }) {
  const detailResponses = createResponseEpoch();

  let detailPollTimer = null;

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
  return { showDetail, invalidate() { detailResponses.invalidate(); if (detailPollTimer !== null) clearTimeout(detailPollTimer); detailPollTimer = null; } };
}
