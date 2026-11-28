import { reviewReasonText } from './review-reason.mjs';
import { titleRoute, requestRoute } from './consumer-route.mjs';

// Owns account tools, invitation links and operational review pagination. Construction does not register event handlers.
export function createAdminController({ api, applyAdultVisibility, byId, element, message, titleLabel, readAdultPreference, reviewResponses, sessionResponses, state, window = globalThis.window, location = globalThis.location, navigator = globalThis.navigator }) {
  let nextReviewAttemptId = null;
  let invitesRead = 0;
  let usersRead = 0;

  function currentAdminSession() {
    const session = sessionResponses.current();
    const userId = state.user?.id;
    return () => sessionResponses.isCurrent(session) &&
      state.user?.id === userId && state.user?.role === 'admin';
  }

  function reviewActionsFor(stage) {
    if (stage === 'removal_hold') return [
      ['retry','Check removal','Check whether the recorded removal finished? This only reads the downloader and staging folder; it does not delete anything.'],
    ];
    if (stage === 'start_hold') return [
      ['retry', 'Retry now', 'Check this download again now? Every normal safety check runs again.'],
      ['release', 'Release download', 'Release this download? Negev removes the stopped torrent from qBittorrent (no files are deleted) and frees its episodes so another release can be chosen.'],
    ];
    if (stage === 'import_hold') return [
      ['retry', 'Retry now', 'Check this import again now? Negev may read the files again.'],
    ];
    return [];
  }

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
        row.classList.add('operational-review-row');
        const label = item.stage === 'release_rejected'
          ? 'Downloaded file rejected' : item.stage === 'removal_hold' ? 'Download removal needs confirmation' : item.stage === 'start_hold'
            ? 'Download start needs review' :
            item.stage === 'completion_interrupted'
              ? 'File check interrupted' : item.stage === 'shoko_rescan_hold'
                ? 'Shoko import needs review' : 'Import held';
        const link=element('a',undefined,'text-link');link.href=requestRoute(item.requestId);
        link.append(titleLabel(item),element('span',` · Request #${item.requestId}`));
        const openTitle=element('a','View title →','text-link');openTitle.href=titleRoute(item.anidbId);
        const copy=element('div');
        const reason = element('small', `${reviewReasonText(item.reason)} · AniDB ${item.anidbId}`);
        reason.title = `Reason code: ${item.reason}`;
        copy.append(link, element('strong', label), reason);
        const actions = element('div', undefined, 'request-actions');
        actions.append(openTitle);
        for (const [action, label, prompt] of reviewActionsFor(item.stage)) {
          const control = element('button', label, action === 'retry' ? 'primary' : 'quiet');
          control.type = 'button';
          control.addEventListener('click', async () => {
            if (!window.confirm(prompt)) return;
            const isCurrent = currentAdminSession();
            for (const button of actions.querySelectorAll('button')) button.disabled = true;
            try {
              const result = await api(`/api/admin/review/${item.attemptId}`, {
                method: 'POST', body: JSON.stringify({ stage: item.stage, action }) });
              if (!isCurrent()) return;
              message(result.state === 'removal_confirmed' ? 'Removal confirmed. Its episodes can be picked up again.' : result.state === 'released'
                ? 'Download released. Its episodes can be picked up again. No media files were removed.'
                : 'Retry scheduled. Negev will check this item again shortly.');
              void loadOperationalReview();
            } catch (error) {
              if (!isCurrent()) return;
              message(error.message, true);
              for (const button of actions.querySelectorAll('button')) button.disabled = false;
            }
          });
          actions.append(control);
        }
        row.append(copy, actions);
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

  function showShareLink(title, url, note, session) {
    if (!sessionResponses.isCurrent(session) || !state.user) return false;
    const box = byId('invite-code');
    const field = element('input');
    field.type = 'text';
    field.readOnly = true;
    field.value = url;
    field.setAttribute('aria-label', title);
    field.addEventListener('focus', () => field.select());
    const copy = element('button', 'Copy link', 'primary');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
        message('Link copied. Share it privately.');
      } catch {
        field.focus();
        message('Select the link and copy it.');
      }
    });
    const close = element('button', 'Done', 'quiet');
    close.type = 'button';
    close.addEventListener('click', () => { box.hidden = true; box.replaceChildren(); });
    const row = element('div', undefined, 'share-link-row');
    row.append(field, copy, close);
    box.replaceChildren(element('strong', title), row, element('small', note));
    box.hidden = false;
    field.focus();
    return true;
  }

  const linkFor = (kind, code) => `${location.origin}/#${kind}=${code}`;

  async function createInviteLink() {
    const session = sessionResponses.current();
    try {
      const result = await api('/api/invitations', { method: 'POST', body: '{}' });
      if (!showShareLink('Invitation link', linkFor('invite', result.code),
        'Works once and expires in 7 days. Anyone with the link can create an account.',
        session)) return;
      message('Invitation link ready.');
      if (state.usersLoaded) void loadInvites();
    } catch (error) { if (sessionResponses.isCurrent(session)) message(error.message, true); }
  }

  const inviteStatusText = { active: 'Active', used: 'Used', expired: 'Expired', revoked: 'Revoked' };

  async function loadInvites(append=false,beforeId=null) {
    if (state.user?.role !== 'admin') return;
    const sessionCurrent = currentAdminSession();
    const read = ++invitesRead;
    const isCurrent = () => sessionCurrent() && read === invitesRead;
    const list = byId('admin-invites');
    if(!append)list.replaceChildren(element('p', 'Loading invitations…', 'muted'));
    try {
      const page = await api('/api/admin/invitations'+(append?'?beforeId='+beforeId:''));
      if (!isCurrent()) return;
      if (!page.items.length) {
        list.querySelector('.older-invitations')?.remove();
        if(!append)list.replaceChildren(element('p', 'No invitations yet.', 'muted'));
        return;
      }
      list.querySelector('.older-invitations')?.remove();
      if(!append)list.replaceChildren();
      list.append(...page.items.map((invite) => {
        const row = element('div', undefined, 'user-setting');
        const when = (ms) => ms === null ? null : new Date(ms).toLocaleDateString();
        const detail = invite.status === 'used'
          ? `used by ${invite.usedBy ?? 'a removed account'} on ${when(invite.usedMs)}`
          : invite.status === 'active' ? `expires ${when(invite.expiresMs)}`
            : invite.status === 'revoked' ? `revoked ${when(invite.revokedMs)}`
              : `expired ${when(invite.expiresMs)}`;
        const created = invite.createdMs === null ? '' : ` · created ${when(invite.createdMs)}`;
        row.append(element('span', `${inviteStatusText[invite.status]} · ${detail}${created}` +
          `${invite.createdBy ? ` by ${invite.createdBy}` : ''}`));
        if (invite.status === 'active') {
          const revoke = element('button', 'Revoke', 'quiet');
          revoke.type = 'button';
          revoke.setAttribute('aria-label', `Revoke the invitation that ${detail}`);
          revoke.addEventListener('click', async () => {
            const mutationCurrent = currentAdminSession();
            revoke.disabled = true;
            try {
              await api(`/api/admin/invitations/${invite.id}/revoke`, { method: 'POST', body: '{}' });
              if (!mutationCurrent()) return;
              message('Invitation revoked. Its link no longer works.');
              void loadInvites();
            } catch (error) { if (mutationCurrent()) { message(error.message, true); revoke.disabled = false; } }
          });
          row.append(revoke);
        }
        return row;
      }));
      if(Number.isSafeInteger(page.nextBeforeId)){
        const more=element('button','Show older invitations','quiet older-invitations');more.type='button';
        more.addEventListener('click',async()=>{if(!sessionCurrent()||!more.isConnected)return;more.disabled=true;await loadInvites(true,page.nextBeforeId);if(more.isConnected)more.disabled=false;});
        list.append(more);
      }
    } catch {
      if (!isCurrent()) return;
      if(!append)list.replaceChildren(element('p', 'Invitations are unavailable right now.', 'muted'));
      else list.append(element('p','Older invitations are unavailable. Try again.','muted'));
    }
  }

  async function loadUsers() {
    if (state.user?.role !== 'admin') return;
    const sessionCurrent = currentAdminSession();
    const read = ++usersRead;
    const isCurrent = () => sessionCurrent() && read === usersRead;
    const list = byId('admin-users');
    list.replaceChildren(element('p', 'Loading accounts…', 'muted'));
    try {
      const page = await api('/api/admin/users');
      if (!isCurrent()) return;
      state.usersLoaded = true;
      list.replaceChildren();
      for (const user of page.items) {
        const row = element('div', undefined, 'user-setting');
        const label = element('span');
        const showLabel = () => {
          label.textContent = `${user.username} · ${user.role}${user.disabled ? ' · disabled' : ''}`;
        };
        showLabel();
        row.append(label);
        const button = element('button', user.adultAllowed ? '18+ allowed' : '18+ blocked',
          'quiet');
        button.type = 'button';
        button.setAttribute('aria-label', `18+ access for ${user.username}`);
        button.setAttribute('aria-pressed', String(user.adultAllowed));
        button.disabled = user.disabled;
        button.addEventListener('click', async () => {
          const mutationCurrent = currentAdminSession();
          button.disabled = true;
          try {
            const result = await api(`/api/admin/users/${user.id}/adult`, {
              method: 'PATCH', body: JSON.stringify({ allowed: !user.adultAllowed }) });
            if (!mutationCurrent()) return;
            user.adultAllowed = result.adultAllowed;
            button.textContent = user.adultAllowed ? '18+ allowed' : '18+ blocked';
            button.setAttribute('aria-pressed', String(user.adultAllowed));
            if (user.id === state.user.id) {
              state.user.adultAllowed = user.adultAllowed;
              state.showAdult = user.adultAllowed && readAdultPreference(user.id);
              applyAdultVisibility();
            }
          } catch (error) { if (mutationCurrent()) message(error.message, true); }
          finally { if (mutationCurrent()) button.disabled = user.disabled; }
        });
        row.append(button);
        const reset = element('button', 'Reset password', 'quiet');
        reset.type = 'button';
        reset.setAttribute('aria-label', `Create a password reset link for ${user.username}`);
        reset.addEventListener('click', async () => {
          const mutationCurrent = currentAdminSession();
          reset.disabled = true;
          try {
            const session = sessionResponses.current();
            const result = await api(`/api/admin/users/${user.id}/password-reset`,
              { method: 'POST', body: '{}' });
            showShareLink(`Password reset link for ${result.username}`, linkFor('reset', result.code),
              'Works once and expires in 24 hours. Using it signs that account out everywhere.' +
              (user.disabled ? ' The account stays disabled until you enable it.' : ''), session);
          } catch (error) { if (mutationCurrent()) message(error.message, true); }
          finally { if (mutationCurrent()) reset.disabled = false; }
        });
        row.append(reset);
        if (user.id !== state.user.id) {
          const access = element('button', user.disabled ? 'Enable account' : 'Disable account',
            'quiet');
          access.type = 'button';
          access.setAttribute('aria-label',
            `${user.disabled ? 'Enable' : 'Disable'} the account ${user.username}`);
          access.addEventListener('click', async () => {
            if (!user.disabled && !confirm(`Disable ${user.username}? They are signed out ` +
                'everywhere and cannot sign in, and their requests pause, until you enable ' +
                'the account again.')) return;
            const mutationCurrent = currentAdminSession();
            access.disabled = true;
            try {
              const result = await api(`/api/admin/users/${user.id}/disabled`, {
                method: 'PATCH', body: JSON.stringify({ disabled: !user.disabled }) });
              if (!mutationCurrent()) return;
              user.disabled = result.disabled;
              access.textContent = user.disabled ? 'Enable account' : 'Disable account';
              access.setAttribute('aria-label',
                `${user.disabled ? 'Enable' : 'Disable'} the account ${user.username}`);
              button.disabled = user.disabled;
              showLabel();
              remove.hidden = !user.disabled;
            } catch (error) { if (mutationCurrent()) message(error.message, true); }
            finally { if (mutationCurrent()) access.disabled = false; }
          });
          // Deleting is only offered once the account is disabled.
          const remove = element('button', 'Delete account', 'quiet danger');
          remove.type = 'button';
          remove.hidden = !user.disabled;
          remove.setAttribute('aria-label', `Permanently delete the account ${user.username}`);
          remove.addEventListener('click', async () => {
            if (!confirm(`Permanently delete ${user.username}? Their account and undispatched requests are ` +
                'removed. Downloads that started or may have started stay as closed history. ' +
                'Unsettled downloads must be reconciled first. This cannot be undone.')) return;
            const mutationCurrent = currentAdminSession();
            remove.disabled = true;
            try {
              const result = await api(`/api/admin/users/${user.id}/delete`,
                { method: 'POST', body: '{}' });
              if (!mutationCurrent()) return;
              message(`Deleted ${result.username}: ${result.deletedRequests} request` +
                `${result.deletedRequests === 1 ? '' : 's'} removed` +
                (result.keptStartedRequests ? `, ${result.keptStartedRequests} started ` +
                  `download${result.keptStartedRequests === 1 ? '' : 's'} kept as history.` : '.'));
              void loadUsers();
            } catch (error) { if (mutationCurrent()) { message(error.message, true); remove.disabled = false; } }
          });
          row.append(access, remove);
        }
        list.append(row);
      }
    } catch {
      if (!isCurrent()) return;
      list.replaceChildren(element('p', 'Account settings are unavailable right now.', 'muted'));
    }
  }
  return { reviewActionsFor, loadOperationalReview, showShareLink, createInviteLink, loadInvites, loadUsers, resetReview() { nextReviewAttemptId = null; } };
}
