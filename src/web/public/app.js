import { createRequestKeyStore } from './request-key.mjs';
import { createEpisodePager } from './episode-pages.mjs';
import { createSearchPager } from './search-pages.mjs';
import { progressText } from './request-progress-text.mjs';
import { createResponseEpoch } from './response-epoch.mjs';

const byId = (id) => document.getElementById(id);
const requestKeys = createRequestKeyStore({ storage: sessionStorage,
  createKey: () => crypto.randomUUID() });
const state = { csrf: null, user: null, selected: null,
  nextBeforeId: null, releaseSearch: false, detailLoad: false,
  searchToken: 0 };
const sessionResponses = createResponseEpoch();
const requestResponses = createResponseEpoch();
const reviewResponses = createResponseEpoch();
let nextReviewAttemptId = null;
function message(text, error = false) {
  const node = byId('message');
  node.textContent = text;
  node.classList.toggle('error', error);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.csrf) {
    headers['x-negev-csrf'] = state.csrf;
  }
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.reason || `Request failed (${response.status})`);
  return data;
}
function showSession(data) {
  if (state.user?.id !== data.user.id) {
    sessionResponses.invalidate();
    requestResponses.invalidate();
    reviewResponses.invalidate();
    byId('request-list').replaceChildren();
    byId('review-list').replaceChildren();
    state.nextBeforeId = null;
    nextReviewAttemptId = null;
  }
  state.user = data.user;
  state.csrf = data.csrfToken;
  state.releaseSearch = data.capabilities?.releaseSearch === true;
  state.detailLoad = data.capabilities?.detailLoad === true;
  byId('service-notice').textContent = data.capabilities?.availabilityChecks === true
    ? 'Negev is in preview. Requests are saved; automatic downloads are not active. Public Plex availability can be checked, and an unconfirmed result does not mean a file is missing.'
    : 'Negev is in preview. Requests are saved; automatic downloads and public Plex checks are not active.';
  byId('auth').hidden = true;
  byId('workspace').hidden = false;
  byId('identity').hidden = false;
  byId('username').textContent = data.user.username;
  byId('invite').hidden = data.user.role !== 'admin';
  byId('admin-review').hidden = data.user.role !== 'admin';
}
function clearWorkspace() {
  sessionResponses.invalidate();
  requestResponses.invalidate();
  reviewResponses.invalidate();
  state.user = null;
  state.csrf = null;
  state.selected = null;
  state.searchToken++;
  state.nextBeforeId = null;
  nextReviewAttemptId = null;
  state.releaseSearch = false;
  state.detailLoad = false;
  byId('service-notice').textContent =
    'Negev is in preview. Requests are saved; automatic downloads are not active.';
  byId('request-list').replaceChildren();
  byId('review-list').replaceChildren();
  byId('more-review').hidden = true;
  byId('admin-review').hidden = true;
  byId('results').replaceChildren(element('p', 'Search by title to begin.', 'muted'));
  byId('detail').replaceChildren(element('p', 'Select a result to see its details.', 'muted'));
  byId('search-form').reset();
  byId('invite-code').textContent = '';
  byId('invite-code').hidden = true;
  byId('identity').hidden = true;
  byId('workspace').hidden = true;
  byId('auth').hidden = false;
}
async function refreshSession() {
  const started = sessionResponses.current();
  try {
    const data = await api('/api/session');
    if (!sessionResponses.isCurrent(started)) return;
    showSession(data);
    await loadRequests();
    if (data.user.role === 'admin') await loadOperationalReview();
  } catch {
    if (sessionResponses.isCurrent(started)) clearWorkspace();
  }
}
async function loadRequests(append = false) {
  const session = sessionResponses.current();
  const listRequest = requestResponses.invalidate();
  const userId = state.user?.id;
  const list = byId('request-list');
  if (!append) list.replaceChildren(element('p', 'Loading requests…', 'muted'));
  const suffix = append && state.nextBeforeId ? `?beforeId=${state.nextBeforeId}` : '';
  try {
    const page = await api(`/api/requests${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !requestResponses.isCurrent(listRequest) || state.user?.id !== userId) return;
    if (!append) list.replaceChildren();
    if (!append && page.items.length === 0) {
      list.append(element('p', 'No requests yet. Search for an anime to begin.', 'muted'));
    }
    for (const item of page.items) {
      const row = element('div', undefined, 'request-row');
      const heading = element('div');
      heading.append(element('strong', item.title || `${item.kind === 'movie' ? 'Film' : 'Series'} · AniDB ${item.anidbId}`),
        element('small', `${item.kind === 'movie' ? 'Film' : 'Series'} · AniDB ${item.anidbId} · Request #${item.id} · ${item.episodeIds.length} ${item.kind === 'movie' ? 'film' : 'episode'} target${item.episodeIds.length === 1 ? '' : 's'} · ${item.monitorFuture ? (item.watchClosed ? 'Future-episode watch finished' : 'Watching for future episodes') : 'One-time request'}`));
      row.append(heading, element('span', progressText(item.progress, item.kind), 'request-status'));
      if (state.user?.role === 'admin' && state.releaseSearch) {
        const button = element('button', 'Review release candidates');
        const candidates = element('div', undefined, 'candidate-list');
        button.addEventListener('click', async () => {
          button.disabled = true;
          candidates.replaceChildren(element('p', 'Searching indexers…', 'muted'));
          try {
            const result = await api(`/api/requests/${item.id}/candidates`);
            candidates.replaceChildren(element('p',
              'Unverified matches only. No download has started.', 'muted'));
            if (result.items.length === 0) {
              candidates.append(element('p', 'No candidates returned by this search.', 'muted'));
            }
            for (const candidate of result.items) {
              const entry = element('div');
              entry.append(element('p',
                `${candidate.title} · ${Math.round(candidate.size / 1_000_000)} MB · ` +
                `${candidate.seeders ?? '?'} seeders`));
              const inspect = element('button', 'Inspect files');
              const inspection = element('div');
              inspect.addEventListener('click', async () => {
                inspect.disabled = true;
                inspection.replaceChildren(element('p', 'Reading torrent file list…', 'muted'));
                try {
                  const preview = await api(`/api/requests/${item.id}/preflight`, {
                    method: 'POST', body: JSON.stringify({ candidate: {
                      guid: candidate.guid, indexerId: candidate.indexerId,
                      title: candidate.title, size: candidate.size,
                    } }),
                  });
                  inspection.replaceChildren(element('p',
                    `Torrent file list: ${preview.files.length} video file(s). ` +
                    'Episode identities are provisional. AniDB file registration is unverified. ' +
                    'No download has started.', 'muted'));
                  for (const file of preview.files) {
                    inspection.append(element('p',
                      `${file.name} → AniDB episode ${file.episodeIds.join(', ')}`));
                  }
                  for (const file of preview.subtitles) {
                    inspection.append(element('p', `${file.name} · subtitle`));
                  }
                  for (const file of preview.filesToExclude) {
                    inspection.append(element('p', `${file.name} · will be excluded before download`));
                  }
                } catch (error) {
                  inspection.replaceChildren(element('p',
                    `Cannot accept this file list: ${error.message}`, 'error'));
                } finally { inspect.disabled = false; }
              });
              entry.append(inspect, inspection);
              candidates.append(entry);
            }
          } catch {
            candidates.replaceChildren(element('p', 'Release search is unavailable right now.', 'muted'));
            button.disabled = false;
          }
        });
        row.append(button, candidates);
      }
      list.append(row);
    }
    state.nextBeforeId = page.nextBeforeId;
    byId('more-requests').hidden = state.nextBeforeId === null;
  } catch (error) {
    if (sessionResponses.isCurrent(session) &&
        requestResponses.isCurrent(listRequest) && state.user?.id === userId) {
      message(error.message, true);
    }
  }
}
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('more-requests').addEventListener('click', () => { void loadRequests(true); });
async function loadOperationalReview(append = false) {
  if (state.user?.role !== 'admin') return;
  const session = sessionResponses.current();
  const read = reviewResponses.invalidate();
  const userId = state.user.id;
  const list = byId('review-list');
  if (!append) list.replaceChildren(element('p', 'Checking held work…', 'muted'));
  const suffix = append && nextReviewAttemptId !== null
    ? `?afterAttemptId=${nextReviewAttemptId}` : '';
  try {
    const page = await api(`/api/admin/review${suffix}`);
    if (!sessionResponses.isCurrent(session) ||
        !reviewResponses.isCurrent(read) || state.user?.id !== userId) return;
    if (!append) list.replaceChildren();
    if (!append && page.items.length === 0) {
      list.append(element('p', 'Nothing needs review.', 'muted'));
    }
    for (const item of page.items) {
      const row = element('div', undefined, 'request-row');
      const label = item.stage === 'release_rejected'
        ? 'Downloaded file rejected' : 'Import held';
      row.append(element('strong', `${label} · Request #${item.requestId}`),
        element('small', `AniDB ${item.anidbId} · ${item.reason.replaceAll('_', ' ')}`));
      list.append(row);
    }
    nextReviewAttemptId = page.nextAfterAttemptId;
    byId('more-review').hidden = nextReviewAttemptId === null;
  } catch (error) {
    if (sessionResponses.isCurrent(session) &&
        reviewResponses.isCurrent(read) && state.user?.id === userId) {
      list.replaceChildren(element('p', error.message, 'muted'));
    }
  }
}
byId('refresh-review').addEventListener('click', () => { void loadOperationalReview(); });
byId('more-review').addEventListener('click', () => { void loadOperationalReview(true); });
function authTab(register) {
  byId('login-form').hidden = register;
  byId('register-form').hidden = !register;
  byId('login-tab').classList.toggle('selected', !register);
  byId('register-tab').classList.toggle('selected', register);
  message('');
}
byId('login-tab').addEventListener('click', () => authTab(false));
byId('register-tab').addEventListener('click', () => authTab(true));
byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({
      username: fields.get('username'), password: fields.get('password'),
    }) });
    event.currentTarget.reset();
    await refreshSession();
    message('Signed in. Search for a show or film.');
  } catch (error) { message(error.message, true); }
});
byId('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({
      code: fields.get('code'), username: fields.get('username'),
      password: fields.get('password'),
    }) });
    event.currentTarget.reset();
    authTab(false);
    message('Account created. Sign in to continue.');
  } catch (error) { message(error.message, true); }
});
byId('signout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  catch (error) { message(error.message, true); return; }
  clearWorkspace();
  message('Signed out.');
});
byId('invite').addEventListener('click', async () => {
  try {
    const result = await api('/api/invitations', { method: 'POST', body: '{}' });
    byId('invite-code').textContent = `Invitation code: ${result.code} · Expires in 7 days. Share it privately.`;
    byId('invite-code').hidden = false;
    message('Invitation ready to copy.');
  } catch (error) { message(error.message, true); }
});
byId('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = byId('query').value.trim();
  if (query.length < 2) return;
  const token = ++state.searchToken;
  const results = byId('results');
  results.replaceChildren(element('p', 'Searching…', 'muted'));
  const appendItems = (items) => {
    for (const item of items) {
      const button = element('button', undefined, 'result');
      button.type = 'button';
      button.append(element('strong', item.title),
        element('small', `AniDB ${item.anidbId} · Details on selection`));
      button.addEventListener('click', () => { void showDetail(item); });
      results.append(button);
    }
  };
  try {
    const data = await api(`/api/catalogue/search?q=${encodeURIComponent(query)}`);
    if (token !== state.searchToken) return;
    const pager = createSearchPager(data);
    results.replaceChildren();
    if (data.catalogueStale) results.append(element('p',
      'AniDB title list may be out of date. Check the title details before requesting.', 'muted'));
    if (data.items.length === 0) results.append(element('p', 'No matching titles in the current catalogue.', 'muted'));
    appendItems(data.items);
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
    results.replaceChildren(element('p', 'Search is unavailable right now.', 'muted'));
    message(error.message, true);
  }
});
async function showDetail(item) {
  state.selected = item.anidbId;
  const panel = byId('detail');
  panel.replaceChildren(element('p', 'Loading details…', 'muted'));
  try {
    const data = await api(`/api/catalogue/${item.anidbId}`);
    if (state.selected !== item.anidbId) return;
    panel.replaceChildren(element('p', data.title || item.title, 'detail-title'));
    if (data.state === 'detail_pending') {
      if (!state.detailLoad) {
        panel.append(element('p', 'Episode details are not cached yet. Detail loading is disabled in this preview, so this title cannot be requested.', 'muted'));
        return;
      }
      panel.append(element('p', 'Episode details are being prepared. This title cannot be requested yet.', 'muted'));
      const button = element('button', 'Load details');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await api(`/api/catalogue/${item.anidbId}/load-detail`,
            { method: 'POST', body: '{}' });
          message(result.state === 'pending' ? 'Detail refresh queued. Check again later.' : 'Details are ready. Select the title again.');
        } catch (error) { message(error.message, true); }
        finally { button.disabled = false; }
      });
      panel.append(button);
      return;
    }
    const pager = createEpisodePager(data);
    panel.append(element('p', `${data.kind === 'movie' ? 'Film' : 'Series'} · ${data.total} listed ${data.kind === 'movie' ? 'film' : 'episode'} target${data.total === 1 ? '' : 's'} · AniDB ${item.anidbId}`, 'detail-meta'));
    const relatedButton = element('button', 'Show related installments');
    const relatedList = element('div', undefined, 'related-list');
    relatedButton.addEventListener('click', async () => {
      relatedButton.disabled = true;
      relatedList.replaceChildren(element('p', 'Checking related titles…', 'muted'));
      try {
        const related = await api(`/api/catalogue/${item.anidbId}/related`);
        if (state.selected !== item.anidbId) return;
        relatedList.replaceChildren(element('p',
          'Related titles found in Shoko. This may not be the complete franchise.', 'muted'));
        if (related.items.length === 0) {
          relatedList.append(element('p', 'No verified direct relationships are cached yet.', 'muted'));
        }
        for (const installment of related.items) {
          const searchButton = element('button', `${installment.title} · ${installment.relation}`);
          searchButton.addEventListener('click', () => {
            void showDetail({ anidbId: installment.anidbId, title: installment.title });
          });
          relatedList.append(searchButton);
        }
      } catch {
        relatedList.replaceChildren(element('p', 'Related titles are unavailable right now.', 'muted'));
        relatedButton.disabled = false;
      }
    });
    panel.append(relatedButton, relatedList);
    // One explicit check at a time: a pending or incomplete public observation
    // is Unknown, never a claim that an episode is missing.
    if (pager.episodes.length > 0) {
      const check = element('div', undefined, 'availability-check');
      if (pager.episodes.some((episode) => episode.availability)) {
        check.append(element('p',
          'Playable labels use recent, verified public Plex evidence. Unlabelled episodes are not confirmed yet.',
          'muted'));
      }
      const label = element('label', data.kind === 'movie' ? 'Check a film target in Plex' : 'Check an episode in Plex');
      const select = element('select');
      const optionText = (episode) =>
        `${episode.type === 'Episode' ? 'Episode' : episode.type} ${episode.number}` +
        `${episode.title ? ` · ${episode.title}` : ''}` +
        `${episode.availability === 'available' ? ' · Playable in Plex' : ''}`;
      const appendOptions = (episodes) => {
        for (const episode of episodes) {
          const option = element('option', optionText(episode));
          option.value = String(episode.id);
          select.append(option);
        }
      };
      const updateOption = (episodeId, availability) => {
        const episode = pager.episodes.find((entry) => entry.id === episodeId);
        const option = [...select.options].find((entry) => entry.value === String(episodeId));
        if (episode && option) {
          episode.availability = availability;
          option.textContent = optionText(episode);
        }
      };
      appendOptions(pager.episodes);
      label.append(select);
      const button = element('button', 'Check availability');
      const result = element('p', '', 'muted');
      select.addEventListener('change', () => { result.textContent = ''; });
      button.addEventListener('click', async () => {
        button.disabled = true;
        select.disabled = true;
        result.textContent = 'Checking the public library…';
        try {
          const status = await api(`/api/catalogue/${item.anidbId}/episodes/${select.value}/availability?kind=${data.kind}`);
          updateOption(Number(select.value), status.state);
          result.textContent = status.state === 'available' ?
            'Playable in Plex' : 'Availability is not confirmed yet';
        } catch (error) { result.textContent = 'Availability check is temporarily unavailable'; }
        finally { button.disabled = false; select.disabled = false; }
      });
      check.append(label, button, result);
      const checkPage = element('button', 'Check next 5 in Plex (once per minute)');
      const checkedList = element('div', undefined, 'availability-results');
      let checkedCount = 0;
      checkPage.addEventListener('click', async () => {
        if (checkedCount >= pager.episodes.length) return;
        checkPage.disabled = true;
        try {
          const page = Math.floor(checkedCount / 100) + 1;
          const offset = checkedCount % 100;
          const checked = await api(`/api/catalogue/${item.anidbId}/availability-page?page=${page}&offset=${offset}`);
          if (state.selected !== item.anidbId) return;
          for (const entry of checked.items) {
            const episode = pager.episodes[checkedCount];
            if (entry.episodeId !== episode?.id) throw new Error('Episode list changed; select the title again');
            updateOption(entry.episodeId, entry.state);
            checkedList.append(element('p', `${episode.type} ${episode.number}: ${entry.state === 'available' ? 'Playable in Plex' : 'Not confirmed yet'}`));
            checkedCount++;
          }
          checkPage.disabled = checkedCount >= pager.episodes.length;
        } catch (error) {
          message(error.message, true);
          checkPage.disabled = false;
        }
      });
      check.append(checkPage, checkedList);
      if (data.kind === 'series' && data.restricted === false) {
        const requestSelected = element('button', 'Request selected episode');
        let requesting = false;
        const updateSelection = () => {
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          requestSelected.disabled = requesting ||
            !['Episode', 'Special'].includes(episode?.type);
          requestSelected.textContent = episode?.type === 'Special'
            ? 'Request this Special' : 'Request this episode';
        };
        select.addEventListener('change', updateSelection);
        updateSelection();
        requestSelected.addEventListener('click', async () => {
          if (requesting) return;
          const episode = pager.episodes.find((entry) => String(entry.id) === select.value);
          if (!['Episode', 'Special'].includes(episode?.type)) return;
          const scope = { userId: state.user.id, anidbId: item.anidbId,
            selection: `episode-${episode.id}` };
          requesting = true;
          updateSelection();
          try {
            const saved = await api('/api/requests', { method: 'POST',
              body: JSON.stringify({ anidbId: item.anidbId, scope: 'episodes',
                episodeIds: [episode.id], requestKey: requestKeys.pending(scope) }) });
            requestKeys.saved(scope);
            message(`Request #${saved.requestId} saved for ${episode.type.toLowerCase()} ${episode.number}. Acquisition is not active in this preview.`);
            await loadRequests();
          } catch (error) { message(error.message, true); }
          finally { requesting = false; updateSelection(); }
        });
        check.append(requestSelected);
      }
      panel.append(check);
      if (pager.nextPage !== null) {
        const more = element('button', 'Show more episodes');
        more.addEventListener('click', async () => {
          more.disabled = true;
          try {
            const page = await api(`/api/catalogue/${item.anidbId}?page=${pager.nextPage}`);
            if (state.selected !== item.anidbId) return;
            const added = pager.append(page);
            if (added.state !== 'appended') throw new Error('Episode list changed; select the title again');
            appendOptions(added.episodes);
            if (checkedCount < pager.episodes.length) checkPage.disabled = false;
            if (pager.nextPage === null) more.remove();
            else more.disabled = false;
          } catch (error) { message(error.message, true); more.disabled = false; }
        });
        panel.append(more);
      }
    }
    if (data.restricted !== false) {
      panel.append(element('p', 'This title is not requestable until its catalogue status is verified.', 'muted'));
      return;
    }
    const button = element('button', `Request ${data.kind === 'movie' ? 'film' : 'series'}`, 'primary');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const scope = { userId: state.user.id, anidbId: item.anidbId };
      const requestKey = requestKeys.pending(scope);
      try {
        const saved = await api('/api/requests', { method: 'POST', body: JSON.stringify({
          anidbId: item.anidbId, scope: 'installment', requestKey,
        }) });
        requestKeys.saved(scope);
        message(`Request #${saved.requestId} saved. Acquisition is not active in this preview.`);
        await loadRequests();
      } catch (error) { message(error.message, true); }
      finally { button.disabled = false; }
    });
    panel.append(button);
  } catch (error) {
    panel.replaceChildren(element('p', 'Details are unavailable right now.', 'muted'));
    message(error.message, true);
  }
}
void refreshSession();
