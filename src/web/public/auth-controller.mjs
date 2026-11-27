

// Owns authentication forms and one-time invitation/reset fragments. Construction does not register event handlers.
export function createAuthController({ api, byId, clearWorkspace, message, refreshSession, sessionResponses, state, location = globalThis.location, history = globalThis.history, FormData = globalThis.FormData }) {
  let pendingLinkCode = (() => {
    const match = /^#(invite|reset)=([a-f0-9]{64})$/i.exec(location.hash);
    if (!match) return null;
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch { /* The code still applies; it only stays visible in the address bar. */ }
    return { kind: match[1].toLowerCase(), code: match[2].toLowerCase() };
  })();

  function applyPendingLinkCode() {
    const link = pendingLinkCode;
    if (!link) return;
    pendingLinkCode = null;
    if (link.kind === 'invite') {
      authTab(true);
      byId('register-form').elements.code.value = link.code;
      message('Invitation found. Choose a username and password to create your account.');
      byId('register-form').elements.username.focus();
    } else {
      byId('login-form').hidden = true;
      byId('register-form').hidden = true;
      const form = byId('reset-form');
      form.hidden = false;
      form.elements.code.value = link.code;
      message('Choose a new password for your account.');
      form.elements.password.focus();
    }
  }

  function authTab(register) {
    byId('login-form').hidden = register;
    byId('register-form').hidden = !register;
    const reset = byId('reset-form');
    if (reset) reset.hidden = true;
    byId('login-tab').classList.toggle('selected', !register);
    byId('register-tab').classList.toggle('selected', register);
    message('');
  }

  const retrySession = () => {
    byId('session-retry').hidden = true;
    byId('session-loading-text').textContent = 'Checking your session…';
    message('');
    void refreshSession();
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({
        username: fields.get('username'), password: fields.get('password'),
      }) });
      sessionResponses.invalidate();
      form.reset();
      if (await refreshSession()) message('Signed in. Search for a show or film.');
    } catch (error) { message(error.message, true); }
  };

  const handleRegisterSubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify({
        code: fields.get('code'), username: fields.get('username'),
        password: fields.get('password'),
      }) });
      form.reset();
      authTab(false);
      message('Account created. Sign in to continue.');
    } catch (error) {
      message(error.message, true);
      if (['code','username','password'].includes(error.field)) form.elements.namedItem(error.field)?.focus();
    }
  };

  async function signOut(everywhere) {
    const session = sessionResponses.current();
    try {
      await api('/api/logout', { method: 'POST',
        body: everywhere ? JSON.stringify({ everywhere: true }) : '{}' });
    } catch (error) {
      if (error.status === 401) { if (!state.user) message('Signed out.'); return; }
      if (sessionResponses.isCurrent(session)) message(error.message, true);
      return;
    }
    if (!sessionResponses.isCurrent(session)) return;
    clearWorkspace();
    message(everywhere ? 'Signed out on all devices.' : 'Signed out.');
    if (pendingLinkCode) applyPendingLinkCode();
  }

  const handleResetSubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      const result = await api('/api/password-reset', { method: 'POST', body: JSON.stringify({
        code: fields.get('code'), password: fields.get('password') }) });
      form.reset();
      authTab(false);
      byId('login-form').elements.username.value = result.username;
      message('Password changed. Sign in with your new password.');
      byId('login-form').elements.password.focus();
    } catch (error) { message(error.message, true); }
  };
  return { applyPendingLinkCode, authTab, retrySession, handleLoginSubmit, handleRegisterSubmit, signOut, handleResetSubmit, get pendingLink() { return pendingLinkCode; } };
}
