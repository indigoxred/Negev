import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminController } from '../src/web/public/admin-controller.mjs';
import { createApiClient } from '../src/web/public/api-client.mjs';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { createSessionController } from '../src/web/public/session-controller.mjs';

function node(tag, text = '', className='') {
  return { tag, className, textContent: text, dataset: {}, children: [], hidden: false,
    listeners: {}, classList: { add() {} }, setAttribute() {}, focus() {}, select() {}, reset() {},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    querySelector(selector){return this.querySelectorAll(selector)[0]??null},
    querySelectorAll(selector) { return this.children.flatMap(child =>
      [...((selector === child.tag || selector.startsWith('.')&&child.className.split(' ').includes(selector.slice(1))) ? [child] : []), ...child.querySelectorAll(selector)]); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } };
}
const text = item => [item.textContent, ...item.children.map(text)].join(' ');
const button = (item, label) => item.tag === 'button' && item.textContent === label ? item :
  item.children.map(child => button(child, label)).find(Boolean);
function fixture() {
  const nodes = new Map(), pending = [], messages = [], epoch = createResponseEpoch();
  const state = { user: { id: 1, username: 'First', role: 'admin', adultAllowed: true },
    csrf: 'first-csrf', searchItems: new Map(), detailHydrationQueued: new Set(), searchToken: 0 };
  const byId = id => { if (!nodes.has(id)) nodes.set(id, node('div')); return nodes.get(id); };
  const document={title:'Negev · Private title'};
  let session,capabilityRefreshes=0;
  const { api } = createApiClient({ state, sessionResponses: epoch,
    clearWorkspace: () => session.clearWorkspace(),
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options,
      finish: (data, status = 200) => resolve(Response.json(data, { status })) })) });
  const controller = createAdminController({ api, byId, state, sessionResponses: epoch,
    reviewResponses: createResponseEpoch(), element: node, message: value => messages.push(value),
    location: { origin: 'https://negev.test' }, window: { confirm: () => true },
    titleLabel: item => node('span', item.title) });
  const noop = () => {};
  const sessionArgs = { document,api, state, byId, element: node, sessionResponses: epoch,
    admin: controller, auth: {}, tracking: { resetTracking: noop }, browse: { setAiringFilters: noop },
    detail: { invalidate: noop,refreshCapabilities:()=>capabilityRefreshes++ }, displayCache: new Map(),
    genreSelections: { airing: new Set(), season: new Set() },
    ensureTrackingPreferences: async () => {}, readAdultPreference: () => true,
    readChinesePreference: () => true, readEnglishTitlePreference: () => false,
    currentAcquisitionNotice: () => '' };
  for (const name of ['airingResponses', 'airingSeasonResponses', 'libraryResponses', 'reviewResponses', 'seasonalResponses']) sessionArgs[name] = createResponseEpoch();
  for (const name of ['resetRoutePosition', 'stopLibraryPageObserver', 'stopBrowsePageObserver',
    'invalidateRequestResponses', 'dismissRequestDialogs', 'applyAdultVisibility', 'applyTitlePreference',
    'renderRoute', 'renderTrackedTitles', 'updateRequestScopeButtons']) sessionArgs[name] = noop;
  session = createSessionController(sessionArgs);
  const switchSession = () => {
    session.clearWorkspace();
    session.showSession({ user: { id: 2, username: 'Second', role: 'admin', adultAllowed: true }, csrfToken: 'second-csrf' });
    messages.length = 0;
  };
  return { controller, byId, state, pending, messages, switchSession, epoch,session,document,get capabilityRefreshes(){return capabilityRefreshes} };
}
const users = name => ({ items: [{ id: 3, username: name, role: 'member', disabled: false, adultAllowed: true }] });
const invites = name => ({ items: [{ id: 7, status: 'used', usedBy: name, usedMs: 1, createdMs: 1 }] });

for (const [method, id, page] of [['loadUsers', 'admin-users', users], ['loadInvites', 'admin-invites', invites]]) {
  test(`${method} ignores an earlier session response through the real API client`, async () => {
    const f = fixture(), old = f.controller[method]();
    f.switchSession();
    f.byId(id).replaceChildren(node('p', 'Current session'));
    f.pending[0].finish(page('Earlier session'));
    await old;
    assert.match(text(f.byId(id)), /Current session/);
    assert.doesNotMatch(text(f.byId(id)), /Earlier session/);
    assert.equal(f.state.usersLoaded, false);
  });
  for (const failed of [false, true]) test(`${method} ignores an older ${failed ? 'failed' : 'successful'} refresh`, async () => {
    const f = fixture(), old = f.controller[method](), latest = f.controller[method]();
    f.pending[1].finish(page('Latest snapshot')); await latest;
    f.pending[0].finish(failed ? { error: 'Old failure' } : page('Old snapshot'), failed ? 503 : 200);
    await old;
    assert.match(text(f.byId(id)), /Latest snapshot/);
    assert.doesNotMatch(text(f.byId(id)), /Old snapshot|unavailable/);
  });
}

test('a delayed invitation link does not reappear after sign-out and another admin signs in', async () => {
  const f = fixture(), old = f.controller.createInviteLink();
  f.switchSession();
  f.pending[0].finish({ code: 'a'.repeat(64) }); await old;
  assert.equal(f.byId('invite-code').hidden, true);
  assert.equal(f.pending.length, 1);
  assert.deepEqual(f.messages, []);
});

for (const failed of [false, true]) test(`a delayed password-reset ${failed ? 'failure' : 'link'} cannot affect another session`, async () => {
  const f = fixture(), load = f.controller.loadUsers();
  f.pending[0].finish(users('Member')); await load;
  const old = button(f.byId('admin-users'), 'Reset password').listeners.click();
  f.switchSession();
  f.pending[1].finish(failed ? { error: 'Earlier reset failed' } : { username: 'Member', code: 'b'.repeat(64) }, failed ? 503 : 200);
  await old;
  assert.equal(f.byId('invite-code').hidden, true);
  assert.deepEqual(f.messages, []);
  assert.equal(f.pending.length, 2);
});

for (const [kind, label, reply] of [
  ['users', '18+ allowed', { adultAllowed: false }],
  ['users', 'Disable account', { disabled: true }],
  ['users', 'Delete account', { username: 'Member', deletedRequests: 1 }],
  ['invites', 'Revoke', { state: 'revoked' }],
  ['review', 'Retry now', { state: 'scheduled' }],
  ['removal', 'Check removal', { state: 'removal_confirmed' }],
]) for (const failed of [false, true]) test(`old ${label} ${failed ? 'failure' : 'success'} cannot publish into another session`, async () => {
  const f = fixture();
  const method = kind === 'users' ? 'loadUsers' : kind === 'invites' ? 'loadInvites' : 'loadOperationalReview';
  const id = kind === 'users' ? 'admin-users' : kind === 'invites' ? 'admin-invites' : 'review-list';
  const page = kind === 'users' ? users('Member') : kind === 'invites'
    ? { items: [{ id: 7, status: 'active', expiresMs: 1, createdMs: 1 }] }
    : { items: [{ attemptId: 8, requestId: 9, anidbId: 10, title: 'Title', stage: kind === 'removal' ? 'removal_hold' : 'start_hold', reason: 'retry' }], nextAfterAttemptId: null };
  if (label === 'Delete account') page.items[0].disabled = true;
  const load = f.controller[method](); f.pending[0].finish(page); await load;
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  let old;
  try { old = button(f.byId(id), label).listeners.click(); }
  finally { globalThis.confirm = previousConfirm; }
  f.switchSession();
  f.pending[1].finish(failed ? { error: 'Earlier mutation failed' } : reply, failed ? 503 : 200);
  await old;
  assert.deepEqual(f.messages, []);
  assert.equal(f.pending.length, 2, 'an old mutation must not start reads in the new session');
});

test('current admin reset and invitation links remain usable', async () => {
  const f = fixture(), load = f.controller.loadUsers();
  f.pending[0].finish(users('Member')); await load;
  const reset = button(f.byId('admin-users'), 'Reset password').listeners.click();
  f.pending[1].finish({ username: 'Member', code: 'b'.repeat(64) }); await reset;
  assert.equal(f.byId('invite-code').hidden, false);
  assert.equal(f.byId('invite-code').children[1].children[0].value,
    'https://negev.test/#reset=' + 'b'.repeat(64));
  const invite = f.controller.createInviteLink();
  f.pending[2].finish({ code: 'a'.repeat(64) }); await invite;
  assert.equal(f.byId('invite-code').children[1].children[0].value,
    'https://negev.test/#invite=' + 'a'.repeat(64));
});

test('current admin account mutations update their controls', async () => {
  const f = fixture(), load = f.controller.loadUsers();
  f.pending[0].finish(users('Member')); await load;
  const adult = button(f.byId('admin-users'), '18+ allowed');
  const changeAdult = adult.listeners.click();
  f.pending[1].finish({ adultAllowed: false }); await changeAdult;
  assert.equal(adult.textContent, '18+ blocked');
  assert.equal(adult.disabled, false);
  const access = button(f.byId('admin-users'), 'Disable account');
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  let changeAccess;
  try { changeAccess = access.listeners.click(); }
  finally { globalThis.confirm = previousConfirm; }
  f.pending[2].finish({ disabled: true }); await changeAccess;
  assert.equal(access.textContent, 'Enable account');
  assert.equal(adult.disabled, true);
  assert.equal(button(f.byId('admin-users'), 'Delete account').hidden, false);
});

test('background capabilities refresh updates the existing detail controls in place',async()=>{
 const f=fixture(),pending=f.session.refreshSession({background:true});
 f.pending[0].finish({user:{...f.state.user},csrfToken:'new',capabilities:{releaseSearch:true}});await pending;
 assert.equal(f.state.releaseSearch,true);assert.equal(f.capabilityRefreshes,1);
});

test('clearing a session also clears the title from the browser tab',()=>{
 const f=fixture();f.session.clearWorkspace();assert.equal(f.document.title,'Negev');
});
