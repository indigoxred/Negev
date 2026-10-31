const byId = (id) => document.getElementById(id);
const state = { csrf: null, user: null, selected: null,
  nextBeforeId: null, releaseSearch: false };
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
  state.user = data.user;
  state.csrf = data.csrfToken;
  state.releaseSearch = data.capabilities?.releaseSearch === true;
  byId('auth').hidden = true;
  byId('workspace').hidden = false;
  byId('identity').hidden = false;
  byId('username').textContent = data.user.username;
  byId('invite').hidden = data.user.role !== 'admin';
}
async function refreshSession() {
  try { showSession(await api('/api/session')); await loadRequests(); }
  catch { byId('auth').hidden = false; byId('workspace').hidden = true; }
}
async function loadRequests(append = false) {
  const list = byId('request-list');
  if (!append) list.replaceChildren(element('p', 'Loading requests…', 'muted'));
  const suffix = append && state.nextBeforeId ? `?beforeId=${state.nextBeforeId}` : '';
  try {
    const page = await api(`/api/requests${suffix}`);
    if (!append) list.replaceChildren();
    if (!append && page.items.length === 0) {
      list.append(element('p', 'No requests yet. Search for an anime to begin.', 'muted'));
    }
    for (const item of page.items) {
      const row = element('div', undefined, 'request-row');
      const heading = element('div');
      heading.append(element('strong', `${item.kind === 'movie' ? 'Film' : 'Series'} · AniDB ${item.anidbId}`),
        element('small', `Request #${item.id} · ${item.episodeIds.length} episode target${item.episodeIds.length === 1 ? '' : 's'}`));
      row.append(heading, element('span', 'Saved · acquisition inactive'));
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
  } catch (error) { message(error.message, true); }
}
byId('refresh-requests').addEventListener('click', () => { void loadRequests(); });
byId('more-requests').addEventListener('click', () => { void loadRequests(true); });
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
  state.user = null;
  state.csrf = null;
  state.nextBeforeId = null;
  state.releaseSearch = false;
  byId('request-list').replaceChildren();
  byId('invite-code').hidden = true;
  byId('identity').hidden = true;
  byId('workspace').hidden = true;
  byId('auth').hidden = false;
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
  const results = byId('results');
  results.replaceChildren(element('p', 'Searching…', 'muted'));
  try {
    const data = await api(`/api/catalogue/search?q=${encodeURIComponent(query)}`);
    results.replaceChildren();
    if (data.items.length === 0) results.append(element('p', 'No matching titles in the current catalogue.', 'muted'));
    for (const item of data.items) {
      const button = element('button', undefined, 'result');
      button.type = 'button';
      button.append(element('strong', item.title),
        element('small', `AniDB ${item.anidbId} · Details on selection`));
      button.addEventListener('click', () => { void showDetail(item); });
      results.append(button);
    }
    message(`${data.total} catalogue result${data.total === 1 ? '' : 's'}.`);
  } catch (error) {
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
    panel.append(element('p', `${data.kind === 'movie' ? 'Film' : 'Series'} · ${data.total} listed episode${data.total === 1 ? '' : 's'} · AniDB ${item.anidbId}`, 'detail-meta'));
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
    if (Array.isArray(data.episodes) && data.episodes.length > 0) {
      const check = element('div', undefined, 'availability-check');
      const label = element('label', 'Check an episode in Plex');
      const select = element('select');
      for (const episode of data.episodes) {
        const option = element('option', `${episode.type === 'Episode' ? 'Episode' : episode.type} ${episode.number}${episode.title ? ` · ${episode.title}` : ''}`);
        option.value = String(episode.id);
        select.append(option);
      }
      label.append(select);
      const button = element('button', 'Check availability');
      const result = element('p', '', 'muted');
      button.addEventListener('click', async () => {
        button.disabled = true;
        result.textContent = 'Checking the public library…';
        try {
          const status = await api(`/api/catalogue/${item.anidbId}/episodes/${select.value}/availability?kind=${data.kind}`);
          result.textContent = status.state === 'available' ?
            'Playable in Plex' : 'Availability is not confirmed yet';
        } catch (error) { result.textContent = 'Availability check is temporarily unavailable'; }
        finally { button.disabled = false; }
      });
      check.append(label, button, result);
      panel.append(check);
    }
    if (data.restricted !== false) {
      panel.append(element('p', 'This title is not requestable until its catalogue status is verified.', 'muted'));
      return;
    }
    const button = element('button', `Request ${data.kind === 'movie' ? 'film' : 'series'}`, 'primary');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const keyName = `negev-request-${item.anidbId}`;
      let requestKey = sessionStorage.getItem(keyName);
      if (!requestKey) {
        requestKey = crypto.randomUUID();
        sessionStorage.setItem(keyName, requestKey);
      }
      try {
        const saved = await api('/api/requests', { method: 'POST', body: JSON.stringify({
          anidbId: item.anidbId, scope: 'installment', requestKey,
        }) });
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
