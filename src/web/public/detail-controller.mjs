import { createInstallmentRequestControls } from './detail-installment-request.mjs';
import { createDetailEpisodeControls } from './detail-episodes.mjs';
import { createDetailRelated } from './detail-related.mjs';
import { createDetailDisplay } from './detail-display.mjs';
import { createSeriesRequestController } from './series-request-controller.mjs';
import { makeReleaseActions } from './release-dialog.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';
import { createResponseEpoch } from './response-epoch.mjs';

import { titleAvailabilitySummary, installmentRequestState } from './season-availability-presentation.mjs';

import { detailOriginalTitle } from './title-preference.mjs';
import { requestRoute } from './consumer-route.mjs';

// Owns detail response epochs, polling, and title request actions. Construction does not register event handlers.
export function createDetailController({
  api,
  applyAdultVisibility,
  byId,
  currentAcquisitionNotice,
  displayCache,
  element,
  loadRequests,
  makeTrackButton,
  message,
  openPreviewReleaseRequests,
  openSavedReleaseRequests,
  posterImage,
  preferredDisplayTitle,
  refreshTrackingAfterRequest,
  requestKeys,
  sessionResponses,
  state,
  titleLabel,
  updateTrackControls,
  document = globalThis.document,
  location = globalThis.location,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  requestAnimationFrame = globalThis.requestAnimationFrame
}) {
  const detailResponses = createResponseEpoch();

  let detailPollTimer = null;
  let requestCapabilities = null;
  let validatedTabTitle=null;
  function refreshTitlePreference(){
    const current=validatedTabTitle;
    const allowed=current?.restricted===false||state.showAdult&&state.user?.adultAllowed===true;
    document.title=current&&current.isCurrent()&&allowed
      ? 'Negev · '+(preferredDisplayTitle?.(current.item)??current.item.title) : 'Negev · Title';
  }

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
    validatedTabTitle=null;document.title='Negev · Title';
    const previousAction = state.selected === item.anidbId
      ? byId('detail').querySelector('.request-action[data-pending="true"]')
      : null;
    if (detailPollTimer !== null) clearTimeout(detailPollTimer);
    detailPollTimer = null;
    requestCapabilities = null;
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
    const recordTabTitle=(title,englishTitle,restricted)=>{
      if(!isCurrentDetail())return;
      validatedTabTitle={item:{title,englishTitle},restricted,isCurrent:isCurrentDetail};refreshTitlePreference();
    };
    const display = createDetailDisplay({ onTitleRendered:recordTabTitle,isCurrentDetail, state, panel, titleLabel, item, setPendingTitleKind, earlyRequest, displaySummary, element, titleBlock });
    const { renderDisplay } = display;
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
      recordTabTitle(originalTitle,item.englishTitle,data.restricted);
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
          const monitored = element('button', data.futureEpisodesPaused ? 'Future episode watch paused' : 'Future episodes already monitored', 'primary');
          monitored.type = 'button';
          monitored.disabled = true;
          panel.append(detailActionRow(monitored));
          if(data.futureEpisodesPaused)panel.append(element('p',requestFailureMessage({reason:'watch_paused_elsewhere'}),'muted'));
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
        const nextAirElement = element('p', undefined,
          `detail-next-air${data.regularSchedule?.nextAirDate ? '' : ' unknown'}`);
        display.mountNextAir(data, nextAirElement);
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
      const related = createDetailRelated({ franchise, item, data, api, isCurrentDetail, element, posterImage, state, panel });
      const { family, relatedDetails, syncInstallmentChoice, loadRelated, relatedHeading } = related;
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
      createDetailEpisodeControls({
        api, currentAcquisitionNotice, data, element, isCurrentDetail, item, loadRequests, message, notReleased, pager, panel, refreshAvailabilitySummary, requestKeys, state,
        get filmChoiceSelect() { return filmChoiceSelect; }, set filmChoiceSelect(value) { filmChoiceSelect = value; },
        get refreshRequestAction() { return refreshRequestAction; }, set refreshRequestAction(value) { refreshRequestAction = value; },
        get refreshSelectedRequestAction() { return refreshSelectedRequestAction; }, set refreshSelectedRequestAction(value) { refreshSelectedRequestAction = value; },
        get loadNextEpisodePage() { return loadNextEpisodePage; }, set loadNextEpisodePage(value) { loadNextEpisodePage = value; }
      });
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
        requestCapabilities = createSeriesRequestController({
          data, pager, item, notReleased, panel, detailActionRow, relatedHeading, loadRelated, family, relatedDetails, isCurrentDetail, element, document, state, makeReleaseActions, titleLabel, preferredDisplayTitle, requestKeys, sessionResponses, api, refreshTrackingAfterRequest, loadRequests, openPreviewReleaseRequests, openSavedReleaseRequests,
          get openSeasonDialog() { return related.openSeasonDialog; }, set openSeasonDialog(value) { related.openSeasonDialog = value; },
          get syncSeasonLookup() { return related.syncSeasonLookup; }, set syncSeasonLookup(value) { related.syncSeasonLookup = value; },
          get syncSeasonRows() { return related.syncSeasonRows; }, set syncSeasonRows(value) { related.syncSeasonRows = value; },
          get refreshRequestAction() { return refreshRequestAction; }, set refreshRequestAction(value) { refreshRequestAction = value; },
          get checkingCompleteSeries() { return checkingCompleteSeries; }, set checkingCompleteSeries(value) { checkingCompleteSeries = value; },
          get loadNextEpisodePage() { return loadNextEpisodePage; }, set loadNextEpisodePage(value) { loadNextEpisodePage = value; },
          get relatedLoading() { return related.relatedLoading; }, set relatedLoading(value) { related.relatedLoading = value; },
          get lastRelatedFailure() { return related.lastRelatedFailure; }, set lastRelatedFailure(value) { related.lastRelatedFailure = value; },
          get expandForOpenPopup() { return related.expandForOpenPopup; }, set expandForOpenPopup(value) { related.expandForOpenPopup = value; }
        });
        return;
      }
      requestCapabilities = createInstallmentRequestControls({
        api, currentAcquisitionNotice, data, detailActionRow, earlyRequest, element, family, isCurrentDetail, item, loadRequests, message, notReleased, openPreviewReleaseRequests, openSavedReleaseRequests, pager, panel, refreshTrackingAfterRequest, related, relatedHeading, requestKeys, state, syncInstallmentChoice,
        get filmChoiceSelect() { return filmChoiceSelect; }, set filmChoiceSelect(value) { filmChoiceSelect = value; },
        get refreshRequestAction() { return refreshRequestAction; }, set refreshRequestAction(value) { refreshRequestAction = value; },
        get checkingCompleteSeries() { return checkingCompleteSeries; }, set checkingCompleteSeries(value) { checkingCompleteSeries = value; },
        get loadNextEpisodePage() { return loadNextEpisodePage; }, set loadNextEpisodePage(value) { loadNextEpisodePage = value; }
      });
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
  return { showDetail,refreshTitlePreference, refreshCapabilities(){requestCapabilities?.refreshCapabilities?.();}, invalidate() { validatedTabTitle=null;requestCapabilities=null; detailResponses.invalidate(); if (detailPollTimer !== null) clearTimeout(detailPollTimer); detailPollTimer = null; } };
}
