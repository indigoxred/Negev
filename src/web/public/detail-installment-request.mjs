import { makeReleaseActions } from './release-dialog.mjs';
import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';
import { installmentRequestState } from './season-availability-presentation.mjs';
import { requestRoute } from './consumer-route.mjs';

export function createInstallmentRequestControls(view) {
  const { api, currentAcquisitionNotice, data, detailActionRow, earlyRequest, element, family, isCurrentDetail, item, loadRequests, message, notReleased, openPreviewReleaseRequests, openSavedReleaseRequests, pager, panel, refreshTrackingAfterRequest, related, relatedHeading, requestKeys, state, syncInstallmentChoice } = view;
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
    related.installmentSelect = element('select');
    related.installmentSelect.addEventListener('change', () => {
      const selectedId = Number(related.installmentSelect.value);
      if (Number.isSafeInteger(selectedId) &&
          family.items().some((entry) => entry.anidbId === selectedId)) {
        if (related.selectedInstallmentId !== selectedId) {
          reviewingRequest = false;
          requestReview.hidden = true;
        }
        related.selectedInstallmentId = selectedId;
        related.selectedAvailability = selectedId === item.anidbId ? 'unknown' : 'checking';
        const checkVersion = ++related.selectedCheckVersion;
        requestStatus.textContent = '';
        related.updateRequestReview();
        view.refreshRequestAction();
        if (selectedId !== item.anidbId) {
          void checkSelectedAvailability(selectedId, checkVersion);
        }
      }
    });
    installmentLabel.append(related.installmentSelect);
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
  const alreadyAvailable = () => related.selectedInstallmentId === item.anidbId
    ? installmentRequestState({ kind: data.kind,
      episodes: pager.episodes, nextPage: pager.nextPage,
      monitorFuture: data.monitorFuture,
      regularSeason: data.regularSeason }) === 'already_available'
    : related.selectedAvailability === 'already_available';
  const requestLabel = () => data.kind === 'movie'
    ? view.filmChoiceSelect?.value ? 'Request selected film' : 'Request film' :
    related.selectedInstallmentId !== item.anidbId ? 'Request selected installment' :
    data.monitorFuture === true && pager.episodes.some((episode) =>
      episode.type === 'Episode' && episode.availability === 'available')
      ? 'Watch future episodes' : 'Request series';
  const button = element('button', requestLabel(), 'primary');
  let requestSaving = false;
  let requestSaved = false;
  let pendingReview=null;
  const reviewSaved=element('button','Review saved request','quiet');reviewSaved.type='button';reviewSaved.hidden=true;
  function deliverReview(){
    if(!isCurrentDetail()||!state.releaseSearch||!pendingReview||requestSaving)return;
    const job=pendingReview;pendingReview=null;reviewSaved.hidden=true;void openSavedReleaseRequests([job],'auto');
  }
  reviewSaved.addEventListener('click',deliverReview);requestAction.append(reviewSaved);
  let reviewingRequest = earlyRequest?.dataset.reviewing === 'true';
  const requestReview = element('div', undefined, 'request-review');
  requestReview.hidden = !reviewingRequest;
  requestReview.append(element('strong', 'Review your request'));
  const reviewSummary = element('p', data.kind === 'movie'
    ? `${data.title || item.title} · one film entry`
    : `${data.title || item.title} · this installment’s regular episodes${data.monitorFuture === true ? ' and future episodes' : ''}`);
  requestReview.append(reviewSummary);
  let filmReleaseMode='auto_review';
  const filmReleasePicker={value:()=>state.releaseSearch?filmReleaseMode:'auto'};
  const filmPopup=element('dialog',undefined,'season-request-dialog release-request-submenu');
  let filmActions=null,filmClose=null;
  const filmFeedback=element('p','','muted');filmFeedback.setAttribute('role','status');
  const automaticRequest=element('button','Save automatic request','primary');
  automaticRequest.type='button';
  automaticRequest.addEventListener('click',()=>{filmReleaseMode='auto';reviewingRequest=true;button.click();});
  if(filmPopup){
    filmPopup.setAttribute('aria-label',data.kind==='movie'?'Request Movie':'Request Series');
    related.openSeasonDialog=filmPopup;
    const heading=element('div',undefined,'season-request-popup-heading');
    const close=element('button','Cancel','quiet');filmClose=close;close.addEventListener('click',()=>{if(!requestSaving)filmPopup.close();});
    heading.append(element('h2',data.kind==='movie'?'Request Movie':'Request Series'),close);
    filmPopup.append(heading,element('p',data.title||item.title));
    filmActions=makeReleaseActions(element,{
      onAuto:()=>{if(requestSaving)return;if(!state.releaseSearch){filmFeedback.textContent='Release search is unavailable. You can still save an automatic request.';return;}filmReleaseMode='auto_review';reviewingRequest=true;button.click();},
      onManual:()=>{if(requestSaving)return;if(!state.releaseSearch){filmFeedback.textContent='Release search is unavailable. You can still save an automatic request.';return;}filmReleaseMode='manual';reviewingRequest=true;button.click();}});
    filmPopup.append(filmActions.element,automaticRequest,filmFeedback);requestAction.append(filmPopup);
    filmPopup.addEventListener('cancel',event=>{if(requestSaving)event.preventDefault();});
    filmPopup.addEventListener('close',()=>{reviewingRequest=false;requestReview.hidden=true;if(!requestSaved){requestStatus.textContent='';view.refreshRequestAction();}});
  }
  requestReview.append(element('p',
    'You can cancel the saved request until Negev starts processing a release. Cancellation does not remove files.',
    'muted'));
  related.updateRequestReview = () => {
    const selected = family.items().find((entry) => entry.anidbId === related.selectedInstallmentId);
    reviewSummary.textContent = related.selectedInstallmentId === item.anidbId
      ? `${data.title || item.title} · this installment’s regular episodes${data.monitorFuture === true ? ' and future episodes' : ''}`
      : `${selected?.title ?? 'Selected installment'} · Negev will check its film or episodes before saving`;
  };
  const cancelReview = element('button', 'Cancel', 'quiet');
  cancelReview.type = 'button';
  cancelReview.addEventListener('click', () => {
    reviewingRequest = false;
    requestReview.hidden = true;
    requestStatus.textContent = '';
    view.refreshRequestAction();
  });
  requestReview.append(cancelReview);
  view.refreshRequestAction = () => {
    if (requestSaving || requestSaved) return;
    const blocked = alreadyAvailable();
    const checkingSelected = related.selectedInstallmentId === item.anidbId
      ? view.checkingCompleteSeries : related.selectedAvailability === 'checking';
    button.disabled = blocked || checkingSelected;
    if(filmActions){filmActions.auto.disabled=button.disabled;filmActions.manual.disabled=button.disabled;}
    button.textContent = blocked ? 'Already available' :
      checkingSelected ? related.selectedInstallmentId === item.anidbId
        ? 'Checking availability…' : 'Checking selected installment…' :
        reviewingRequest ? 'Confirm request' : requestLabel();
    if (blocked) requestStatus.textContent = 'This installment is already verified in Negev’s Library.';
    else if (checkingSelected && related.selectedInstallmentId !== item.anidbId) {
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
    if (!isCurrentDetail() || checkVersion !== related.selectedCheckVersion ||
        related.selectedInstallmentId !== selectedId) return;
    related.selectedAvailability = result;
    requestStatus.textContent = result === 'unknown'
      ? 'Availability could not be confirmed here. Negev will check before saving.' : '';
    view.refreshRequestAction();
  };
  view.refreshRequestAction();
  const filmEntries = data.kind === 'movie'
    ? pager.episodes.filter((episode) => episode.type === 'Episode') : [];
  const needsFilmChoice = data.kind === 'movie' &&
    (filmEntries.length !== 1 || pager.nextPage !== null);
  let filmChoice;
  if (needsFilmChoice) {
    filmChoice = element('div', undefined, 'film-request-choice');
    filmChoice.hidden = true;
    const label = element('label', 'Choose the film version or part');
    view.filmChoiceSelect = element('select');
    view.filmChoiceSelect.addEventListener('change', () => {
      reviewingRequest = false;
      requestReview.hidden = true;
      requestStatus.textContent = '';
      view.refreshRequestAction();
    });
    const placeholder = element('option', 'Select a main film entry');
    placeholder.value = '';
    view.filmChoiceSelect.append(placeholder);
    for (const episode of filmEntries) {
      const option = element('option', `Episode ${episode.number}${episode.title ? ` · ${episode.title}` : ''}`);
      option.value = String(episode.id);
      view.filmChoiceSelect.append(option);
    }
    label.append(view.filmChoiceSelect);
    filmChoice.append(label);
    if (pager.nextPage !== null) filmChoice.append(element('p',
      'More film entries may be listed under Episode and Special options below.', 'muted'));
    if(filmPopup)filmPopup.insertBefore(filmChoice,filmActions.element);else requestAction.append(filmChoice);
  }
  button.addEventListener('click', async () => {
    if (alreadyAvailable() || related.selectedAvailability === 'checking' ||
        requestSaving || requestSaved) return;
    if((state.releaseSearch||needsFilmChoice)&&filmPopup&&!filmPopup.open){
      if(filmChoice)filmChoice.hidden=false;
      filmPopup.showModal();return;
    }
    if (needsFilmChoice && !view.filmChoiceSelect.value) {
      filmChoice.hidden = false;
      button.textContent = 'Request selected film';
      requestStatus.textContent = 'Choose one main film entry above.';
      view.filmChoiceSelect.focus();
      return;
    }
    if (!reviewingRequest) {
      if (needsFilmChoice) {
        const selectedFilm = pager.episodes.find((episode) =>
          String(episode.id) === view.filmChoiceSelect.value);
        reviewSummary.textContent = `${data.title || item.title} · ` +
          `main film entry ${selectedFilm?.number ?? '?'}${selectedFilm?.title ? ` · ${selectedFilm.title}` : ''}`;
      }
      reviewingRequest = true;
      requestReview.hidden = false;
      button.textContent = 'Confirm request';
      requestStatus.textContent = 'Review this installment, then confirm.';
      return;
    }
    const submittedMode=state.releaseSearch?filmReleaseMode:'auto';
    if(submittedMode==='manual'){
      const selectedFilmId=needsFilmChoice?Number(view.filmChoiceSelect.value):null;
      const keyScope={userId:state.user.id,anidbId:related.selectedInstallmentId,
        ...(selectedFilmId?{selection:'film-entry-'+selectedFilmId}:{})};
      filmPopup?.close();
      await openPreviewReleaseRequests([{title:data.title||item.title,englishTitle:data.englishTitle||item.englishTitle,
        body:{anidbId:related.selectedInstallmentId,scope:selectedFilmId?'episodes':'installment',
          ...(selectedFilmId?{episodeIds:[selectedFilmId]}:{}),requestKey:requestKeys.pending(keyScope)},
        saved:result=>{requestKeys.saved(keyScope);requestSaved=true;reviewingRequest=false;requestReview.hidden=true;
          button.textContent='Requested';button.disabled=true;requestStatus.textContent=savedRequestMessage(result);
          if(Number.isSafeInteger(result.requestId)&&result.requestId>0)viewRequest.href=requestRoute(result.requestId);
          viewRequest.hidden=false;}}]);
      return;
    }
    requestSaving = true;
    if(filmActions){filmActions.auto.disabled=true;filmActions.manual.disabled=true;filmClose.disabled=true;filmFeedback.textContent='Saving request…';}
    if (related.installmentSelect) related.installmentSelect.disabled = true;
    if (view.filmChoiceSelect) view.filmChoiceSelect.disabled = true;
    button.disabled = true;
    button.textContent = 'Saving request…';
    requestStatus.textContent = 'Saving your request…';
    const selectedFilmId = needsFilmChoice ? Number(view.filmChoiceSelect.value) : null;
    const scope = { userId: state.user.id, anidbId: related.selectedInstallmentId,
      ...(selectedFilmId ? { selection: `film-entry-${selectedFilmId}` } : {}) };
    try {
      const requestKey = requestKeys.pending(scope);
      const saved = await api('/api/requests', { method: 'POST', body: JSON.stringify({
        anidbId: related.selectedInstallmentId,
        scope: selectedFilmId ? 'episodes' : 'installment',
        ...(selectedFilmId ? { episodeIds: [selectedFilmId] } : {}), requestKey,
        ...(submittedMode==='auto'?{}:{releaseMode:submittedMode}),
      }) });
      requestKeys.saved(scope);
      refreshTrackingAfterRequest();
      requestSaved = true;
      reviewingRequest = false;
      requestReview.hidden = true;
      button.textContent = 'Requested';
      requestStatus.textContent = savedRequestMessage(saved);
      filmPopup?.close();
      if(submittedMode==='auto_review'&&saved.created!==false&&Number.isSafeInteger(saved.requestId))pendingReview={requestId:saved.requestId,title:data.title||item.title,englishTitle:data.englishTitle||item.englishTitle};
      if (Number.isSafeInteger(saved.requestId) && saved.requestId > 0) {
        viewRequest.href = requestRoute(saved.requestId);
      }
      viewRequest.hidden = false;
      message(saved.state === 'pending'
        ? 'Request saved. Follow it under My Requests.'
        : `Request #${saved.requestId} saved. ${currentAcquisitionNotice()}`);
      loadRequests();
      requestSaving=false;deliverReview();reviewSaved.hidden=!state.releaseSearch||!pendingReview;
    } catch (error) {
      const feedback = requestFailureMessage(error);
      filmFeedback.textContent=feedback;if(filmClose)filmClose.disabled=false;
      requestStatus.textContent = feedback;
      message(feedback, true);
      requestSaving = false;
      if (related.installmentSelect) related.installmentSelect.disabled = false;
      if (view.filmChoiceSelect) view.filmChoiceSelect.disabled = false;
      view.refreshRequestAction();
    }
  });
  requestAction.append(requestReview, detailActionRow(button), requestStatus, viewRequest);
  if (view.checkingCompleteSeries && view.loadNextEpisodePage) {
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
        if (!await view.loadNextEpisodePage(false)) {
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
      view.checkingCompleteSeries = false;
      requestStatus.textContent = '';
      view.refreshRequestAction();
    };
    continueCheck.addEventListener('click', () => { void checkPages(); });
    void checkPages();
  }
  const refreshCapabilities=()=>{
    reviewSaved.hidden=!state.releaseSearch||!pendingReview;reviewSaved.disabled=requestSaving;
    filmActions.element.hidden=filmActions.auto.hidden=filmActions.manual.hidden=!state.releaseSearch;
    automaticRequest.hidden=state.releaseSearch;
    if(!state.releaseSearch&&filmPopup.open)filmFeedback.textContent='Release search is unavailable. You can still save an automatic request.';
    view.refreshRequestAction();
  };
  refreshCapabilities();
  return {refreshCapabilities};
}
