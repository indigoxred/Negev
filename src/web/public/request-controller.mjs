import { requestPresentation, requestNeedsReleaseChoice, requestHasPendingAcquisition, requestCanEditReleasePreference } from './request-progress-text.mjs';
import { requestFailureMessage } from './request-feedback.mjs';
import { watchingNextAirLabel } from './episode-schedule.mjs';
import { titleRoute, requestRoute } from './consumer-route.mjs';

// Owns request lists, preparation history and request status rendering. Construction does not register event handlers.
export function createRequestController({ api, byId, element, message, posterImage, preferredDisplayTitle, releaseDialog, requestResponses, restoreRoutePosition, sessionResponses, state, titleLabel, document = globalThis.document, window = globalThis.window }) {
  function expandedRequestDetails(list) {
    return new Map([...list.querySelectorAll('.request-row[data-request-id]')]
      .map(row => [row.dataset.requestId,
        new Set([...row.querySelectorAll('details[open]')].map(details => details.className))]));
  }

  async function loadRequestView(view, append = false, silent = false) {
    if (!state.user) return;
    const session = sessionResponses.current();
    const responseEpoch = requestResponses[view];
    const listRequest = responseEpoch.invalidate();
    const userId = state.user?.id;
    const scope = state.requestScope;
    const watching = view === 'watching';
    const list = byId(watching ? 'watch-list' : 'request-list');
    const more = byId(watching ? 'more-watches' : 'more-requests');
    const priorDetails = !append && !silent ? expandedRequestDetails(list) : null;
    let expandedGroups = !watching && !append
      ? new Set([...list.querySelectorAll('details.request-group[open]')]
        .map((group) => group.dataset.requestGroup)) : new Set();
    if (!append && !silent) {
      state.nextBeforeId[view] = null;
      more.hidden = true;
      list.replaceChildren(element('p', watching ? 'Loading watches…' : 'Loading requests…', 'muted'));
    }
    const suffix = append && state.nextBeforeId[view]
      ? `&beforeId=${state.nextBeforeId[view]}` : '';
    try {
      const focused = state.focusedRequestId;
      const page = await api(`/api/requests?view=${focused?'all':view}&scope=${scope}${focused?`&requestId=${focused}`:suffix}`);
      if (!sessionResponses.isCurrent(session) ||
          !responseEpoch.isCurrent(listRequest) || state.user?.id !== userId ||
          state.requestScope !== scope) return;
      // Read at commit time: respect sections toggled while the poll was pending.
      const openDetails = append ? new Map() : silent ? expandedRequestDetails(list) : priorDetails;
      if (silent && !watching && !append) expandedGroups = new Set([...list.querySelectorAll('details.request-group[open]')]
        .map(group => group.dataset.requestGroup));
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
        const row = element('div', undefined, 'request-row request-entry');
        row.dataset.requestId=String(item.id);
        row.dataset.recentPage = String(!append);
        row.append(posterImage(item));
        const heading = element('div',undefined,'request-heading');
        const targetCount = item.episodeIds.length;
        const requestedScope = item.kind === 'movie'
          ? targetCount === 1 ? 'Film requested' : `${targetCount} film parts requested`
          : `${targetCount} episode${targetCount === 1 ? '' : 's'} requested`;
        heading.append(titleLabel({ ...item, title: item.title ||
          `${item.kind === 'movie' ? 'Film' : 'Series'} · AniDB ${item.anidbId}` }),
          element('small', `${item.kind === 'movie' ? 'Film' : 'Series'} · ` +
            `${requestedScope} · ` +
            `${item.monitorFuture ? (item.watchClosed ? 'Future-episode watch finished' : 'Watching for future episodes') : 'One-time request'}`),
          element('small', `Requested by ${item.requesterName || `User #${item.requesterId}`}`,
            'request-owner'));
        const number=element('a',`Request #${item.id}`,'text-link request-number');
        number.href=requestRoute(item.id);heading.querySelector('.request-owner').append(' · ',number);
        const openTitle = element('a', 'View title →', 'text-link');
        openTitle.href = titleRoute(item.anidbId);
        const actions = element('div', undefined, 'request-actions');
        actions.append(openTitle);
        const details = element('div', undefined, 'request-details');
        if (state.user?.role === 'admin') {
          const technical = element('details', undefined, 'request-technical');
          technical.append(element('summary', 'Technical details'),
            element('small', `AniDB ${item.anidbId} · Request #${item.id}`));
          details.append(technical);
        }
        const presentation = requestItemPresentation(item);
        const status = element('div', undefined,
          `request-status status-${presentation.group}`);
        status.negevRequest = item;
        renderRequestStatus(status, presentation);
        row.append(heading, status, actions);
        if (state.user?.role === 'admin' && item.status === 'held' &&
            item.progress?.state === 'owner_review_pending' && item.canCancel === true) {
          for (const [action, label] of [['approve', 'Approve request'],
            ['cancel', 'Cancel request']]) {
            const control = element('button', label, action === 'approve' ? 'primary' : 'quiet');
            control.type = 'button';
            control.addEventListener('click', async () => {
              if (!window.confirm(action === 'approve'
                ? 'Approve this request and allow Negev to look for a download?'
                : 'Cancel this request? No media files will be removed.')) return;
              control.disabled = true;
              try {
                await api(`/api/admin/requests/${item.id}/review`, {
                  method: 'POST', body: JSON.stringify({ action }) });
                message(action === 'approve' ? 'Request approved for acquisition.' :
                  'Request cancelled. No media files were removed.');
                loadRequests();
              } catch (error) { message(error.message, true); control.disabled = false; }
            });
            actions.append(control);
          }
        } else if (item.status === 'held' && item.canCancel !== false &&
            (item.requesterId === state.user?.id || state.user?.role === 'admin')) {
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
          actions.append(cancel);
        } else if (item.status === 'held' && item.canCancel === false) {
          const cancellationInfo = element('details', undefined, 'request-cancellation-info');
          cancellationInfo.append(element('summary', 'Cancellation'), element('small',
            'Cancellation is unavailable once release processing starts, even before a download begins.', 'muted'));
          details.append(cancellationInfo);
        }
        if (state.releaseSearch && requestNeedsReleaseChoice(item) &&
            (state.user?.role === 'admin' || item.requesterId === state.user?.id)) {
          const tools=element('div',undefined,'release-search-actions');
          for(const [mode,label] of [['auto','Auto-Pick'],['manual','Manual Pick']]) {
            const search=element('button',label,'quiet');
            search.addEventListener('click',()=>{void releaseDialog.open({requestId:item.id,title:preferredDisplayTitle(item)??'Anime request',mode});});
            tools.append(search);
          }
          const releaseOptions = element('details', undefined, 'request-release-options');
          releaseOptions.append(element('summary', 'Release options'), tools);
          details.append(releaseOptions);
        }
        if(state.releaseSearch&&requestCanEditReleasePreference(item)&&
            (state.user?.role==='admin'||item.requesterId===state.user?.id)) {
          const preference=element('div',undefined,'request-group-preference');
          const edit=element('button','Release-group preference','quiet');
          edit.addEventListener('click',()=>{void releaseDialog.open({requestId:item.id,title:preferredDisplayTitle(item)??'Anime request',preferenceOnly:true});});
          preference.append(edit);
          if(item.releasePreference?.group)preference.append(element('small','Preferred group: '+item.releasePreference.group,'muted'));
          details.append(preference);
        }
        if (details.childElementCount) {
          const more = element('details', undefined, 'request-more');
          more.append(element('summary', 'Details & options'), details);
          row.append(more);
        }
        const expanded = openDetails?.get(String(item.id));
        if (expanded) for (const section of row.querySelectorAll('details')) {
          section.open = expanded.has(section.className);
        }
        if (watching) list.append(row);
        else requestGroupRows(list, presentation.group, expandedGroups).append(row);
      }
      if (focused) for(const group of list.querySelectorAll('details.request-group')) group.open=true;
      restoreRoutePosition();
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
          responseEpoch.isCurrent(listRequest) && state.user?.id === userId &&
          state.requestScope === scope) {
        if (!append && !silent) list.replaceChildren(element('p',
          'Could not load requests. Select Refresh to try again.', 'error'));
        if (!silent) message(error.message, true);
      }
    }
  }

  const historyGroupOrder = ['attention', 'active', 'completed', 'cancelled'];

  const historyGroupTitles = {
    attention: 'Needs attention', active: 'Active', completed: 'Completed',
    cancelled: 'Cancelled',
  };

  function requestGroupRows(list, group, expandedGroups = new Set()) {
    const category = historyGroupOrder.includes(group) ? group : 'active';
    let section = [...list.children].find((child) =>
      child.dataset.requestGroup === category);
    if (!section) {
      const collapsible = category === 'completed' || category === 'cancelled';
      section = element(collapsible ? 'details' : 'section', undefined, 'request-group');
      section.dataset.requestGroup = category;
      if (collapsible && expandedGroups.has(category)) section.open = true;
      section.append(element(collapsible ? 'summary' : 'h3', historyGroupTitles[category]),
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
    let detail=presentation.detail,note=presentation.note;
    if(presentation.stage==='Needs attention'&&note){detail=note;note='';}
    if(presentation.stage==='Awaiting owner review'&&note){detail=note;note='';}
    if(presentation.stage==='Downloading')detail=detail.replace(/^One release is [0-9.]+% downloaded\. /,'One release · ');
    status.replaceChildren(element('strong', presentation.stage, 'request-stage'),element('span',detail,'request-detail'));
    const nextAir = watchingNextAirLabel(status.negevRequest);
    if (nextAir) status.append(element('span', nextAir, 'request-next-air'));
    if (Number.isFinite(presentation.progressPercent)) {
      const transfer = element('div', undefined, 'request-transfer-meter');
      const meter = element('div', undefined, 'request-transfer-progress');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', String(presentation.progressPercent));
      meter.setAttribute('aria-label',
        `Download progress: ${presentation.progressPercent}%`);
      const fill = element('div', undefined, 'request-transfer-fill');
      fill.style.width = `${presentation.progressPercent}%`;
      meter.append(fill);
      transfer.append(meter,
        element('span', `${presentation.progressPercent}%`, 'request-transfer-percent'));
      status.append(transfer);
    }
    if (note&&note!==detail) status.append(element('span', note,
      'request-note'));
  }

  function requestItemPresentation(item) {
    if(requestNeedsReleaseChoice(item)&&item.releaseSelection?.phase==='selecting'&&item.releaseSelection.mode==='auto') {
      return {stage:'Choosing a release',detail:'Auto-Pick is comparing eligible releases.',note:'Your request is saved; you can leave this page.',group:'active'};
    }
    if(requestNeedsReleaseChoice(item)&&item.releaseSelection?.phase==='selecting'&&item.releaseSelection.mode==='manual') {
      return {stage:'Choose a release',detail:'Open Manual Pick to finish this request.',note:'Automatic grabbing is paused for this selection.',group:'active'};
    }
    if(requestNeedsReleaseChoice(item)&&item.releaseSelection?.phase==='proposal') {
      return {stage:'Release choice ready',detail:'Open Auto-Pick to review the better release.',note:'The evidence-backed option is used automatically after five minutes.',group:'active'};
    }
    if(requestHasPendingAcquisition(item)&&item.preferredWait?.deadlineMs>Date.now()&&
        !['active','queued'].includes(item.progress?.transfer?.transferState)) {
      return {stage:`Waiting for ${item.preferredWait.group}`,
        detail:`Until ${new Date(item.preferredWait.deadlineMs).toLocaleString()}`,
        note:'Another release is available. Negev will use a suitable alternative if the preferred group does not arrive.',group:'active'};
    }
    return item.status === 'cancelled'
      ? { stage: 'Cancelled', detail: 'No further downloads or episode monitoring.',
        note: 'Existing files remain in your library.', group: 'cancelled' }
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
      const page = await api(`/api/requests?view=history&scope=${state.requestScope}&limit=50`);
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
        if (status.negevRequest?.canCancel !== item.canCancel ||
            requestNeedsReleaseChoice(status.negevRequest) !== requestNeedsReleaseChoice(item)) {
          void loadRequestView('history', false, true);
          return;
        }
        if (status.negevRequest?.progress?.state !== item.progress?.state &&
            (status.negevRequest?.progress?.state === 'owner_review_pending' ||
              item.progress?.state === 'owner_review_pending')) {
          void loadRequestView('history', false, true);
          return;
        }
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
    if (state.focusedRequestId) {
      requestResponses.preparing.invalidate();requestResponses.watching.invalidate();
      byId('preparing-list').replaceChildren();byId('watch-list').replaceChildren();
      void loadRequestView('history',false,silent);return;
    }
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
        section.append(element('h3', 'Your preparations'),
          element('div', undefined, 'request-group-rows'));
        list.append(section);
      }
      const rows = section?.lastElementChild;
      for (const item of page.items) {
        if (item.state === 'cancelled') continue;
        const row = element('div', undefined, 'request-row');
        row.append(posterImage(item));
        const heading = element('div');
        heading.append(titleLabel(item),
          element('small', item.reason === 'watch_paused_elsewhere' || item.state === 'complete' && item.reason === 'already_monitored_elsewhere'
            ? requestFailureMessage(item) : item.reason === 'release_state_unknown'
            ? 'Checking catalogue release dates' : 'Preparing episode details'),
          element('small', `Requested by ${item.requesterName || 'your account'}`));
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
        row.append(heading, element('p', item.reason === 'watch_paused_elsewhere' ? requestFailureMessage(item) : item.state === 'complete'
          ? item.reason === 'already_available'
            ? 'Already available in Negev’s Library.'
            : item.reason === 'ambiguous_movie_scope'
              ? 'Choose a film part on the title page to request it.'
              : 'This title could not be requested automatically.'
          : item.state === 'resolving'
            ? 'Finishing the request. Cancellation is unavailable during this step.'
            : item.reason === 'release_state_unknown'
              ? 'Negev cannot confirm this title’s release timing yet. No download has started.'
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
  return { expandedRequestDetails, loadRequestView, requestGroupRows, renderRequestStatus, requestItemPresentation, refreshRequestStatusAges, refreshExpandedHistory, loadRequests, loadPreparations, refreshVisibleRequests };
}
