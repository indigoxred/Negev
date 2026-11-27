import { filmEntryRequestState } from './season-availability-presentation.mjs';
import { episodeScheduleLabel } from './episode-schedule.mjs';

export function createDetailEpisodeControls(view) {
  const { api, currentAcquisitionNotice, data, element, isCurrentDetail, item, loadRequests, message, notReleased, pager, panel, refreshAvailabilitySummary, requestKeys, state, Event = globalThis.Event } = view;
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
        if (view.filmChoiceSelect && episode.type === 'Episode') {
          view.filmChoiceSelect.append(option.cloneNode(true));
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
        view.refreshRequestAction();
        view.refreshSelectedRequestAction();
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
      view.refreshSelectedRequestAction = updateSelection;
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
      view.loadNextEpisodePage = async (notifyError = true) => {
        if (pager.nextPage === null || more.disabled) return false;
        more.disabled = true;
        try {
          const page = await api(`/api/catalogue/${item.anidbId}?page=${pager.nextPage}`);
          if (!isCurrentDetail()) return false;
          const added = pager.append(page);
          if (added.state !== 'appended') throw new Error('Episode list changed; select the title again');
          appendOptions(added.episodes);
          refreshAvailabilitySummary();
          view.refreshRequestAction();
          if (pager.nextPage === null) more.remove();
          else more.disabled = false;
          return true;
        } catch (error) {
          if (notifyError) message(error.message, true);
          more.disabled = false;
          return false;
        }
      };
      more.addEventListener('click', () => { void view.loadNextEpisodePage(); });
      advanced.append(more);
    }
  }

}
