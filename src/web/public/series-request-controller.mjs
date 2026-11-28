import { canOpenSeasonRequest, seasonRequestStatus, seasonSelectionSummary, seasonSelectionScope, seasonTriggerPresentation } from './season-request-selection.mjs';
import { requestFailureMessage } from './request-feedback.mjs';
import { requestRoute } from './consumer-route.mjs';

// The detail view supplies live adapters for paging and related-title progress.
export function createSeriesRequestController(detailView) {
  const { data, pager, item, notReleased, panel, detailActionRow, relatedHeading, loadRelated, family, relatedDetails, isCurrentDetail, element, document, state, makeReleaseActions, titleLabel, preferredDisplayTitle, requestKeys, sessionResponses, api, refreshTrackingAfterRequest, loadRequests, openPreviewReleaseRequests, openSavedReleaseRequests } = detailView;
  const availableButton = element('button', 'Already available',
    'primary season-already-available');
  availableButton.type = 'button';
  availableButton.disabled = true;
  availableButton.hidden = true;
  const trigger = element('button', 'Request series', 'primary season-request-trigger');
  trigger.type = 'button';
  const monitoredButton = element('button', data.futureEpisodesPaused ? 'Future episode watch paused' : 'Future episodes already monitored',
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
  if(data.futureEpisodesPaused)panel.append(element('p',requestFailureMessage({reason:'watch_paused_elsewhere'}),'muted'));
  const action = element('dialog', undefined,
    'request-action season-request-action season-request-dialog');
  detailView.openSeasonDialog = action;
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
  detailView.syncSeasonLookup = () => {
    moreSeasons.hidden = family.next() === null;
    moreSeasons.disabled = detailView.relatedLoading;
    moreSeasons.textContent = detailView.lastRelatedFailure
      ? 'Retry finding seasons' : 'Find more seasons or installments';
    const incomplete = detailView.relatedLoading || !!detailView.lastRelatedFailure || !!family.next();
    lookupNotice.textContent = detailView.relatedLoading
      ? 'Finding linked seasons. This list is not complete yet.'
      : detailView.lastRelatedFailure
        ? `Season list incomplete. Other seasons may be missing. ${detailView.lastRelatedFailure}`
        : family.next()
          ? 'More linked seasons may exist. Find more before selecting all shown.'
          : '';
    lookupNotice.classList.toggle('incomplete', incomplete);
  };
  detailView.syncSeasonLookup();
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
    const status = row.anidbId === item.anidbId && detailView.checkingCompleteSeries
      ? { state: 'unverified', text: 'Checking complete season…', selectable: false }
      : seasonRequestStatus(detail);
    if (status === null) { row.element.remove(); rows.delete(row.anidbId); refresh(); return; }
    row.activeWatchRequestId = detail?.activeWatchRequestId ?? null;
    row.futureEpisodesMonitored = detail?.futureEpisodesMonitored === true ||
      row.activeWatchRequestId > 0;
    const watchText = detail?.futureEpisodesPaused ? requestFailureMessage({reason:'watch_paused_elsewhere'}) : 'Future episodes already monitored';
    row.status = row.futureEpisodesMonitored
      ? { state: 'watching', text: watchText,
        selectable: false } : status;
    row.statusText.textContent = row.futureEpisodesMonitored
      ? watchText : row.requested ? 'Requested' : status.text;
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
  detailView.syncSeasonRows = () => {
    for (const entry of family.items()) addRow(entry);
    detailView.syncSeasonLookup();
    refresh();
  };
  detailView.syncSeasonRows();
  let continueCheck = null;
  detailView.refreshRequestAction = () => {
    if (pager.nextPage === null) {
      detailView.checkingCompleteSeries = false;
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
    if (family.next() && !detailView.lastRelatedFailure) {
      if (detailView.relatedLoading) detailView.expandForOpenPopup = true;
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
        } else if (payload.reason === 'watch_paused_elsewhere') {
          row.statusText.textContent = requestFailureMessage(payload);
          failed.push(row.title);
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
  if (detailView.checkingCompleteSeries && detailView.loadNextEpisodePage) {
    continueCheck = element('button', 'Continue availability check', 'quiet');
    continueCheck.hidden = true;
    continueCheck.type = 'button';
    panel.append(continueCheck);
    const checkPages = async () => {
      continueCheck.hidden = true;
      for (let page = 0; page < 20 && pager.nextPage !== null; page++) {
        if (!isCurrentDetail()) return;
        if (!await detailView.loadNextEpisodePage(false)) {
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
      detailView.checkingCompleteSeries = false;
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

}
