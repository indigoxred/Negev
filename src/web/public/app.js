const byId = (id) => document.getElementById(id);
const state = { csrf: null, user: null, selected: null };
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
  byId('auth').hidden = true;
  byId('workspace').hidden = false;
  byId('identity').hidden = false;
  byId('username').textContent = data.user.username;
  byId('invite').hidden = data.user.role !== 'admin';
}
async function refreshSession() {
  try { showSession(await api('/api/session')); }
  catch { byId('auth').hidden = false; byId('workspace').hidden = true; }
}
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
