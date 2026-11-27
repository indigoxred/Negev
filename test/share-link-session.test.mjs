import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { createAdminController } from '../src/web/public/admin-controller.mjs';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function context(pending) {
  const box = { hidden: true, children: [], replaceChildren(...nodes) { this.children = nodes; } };
  const node = () => ({ addEventListener() {}, setAttribute() {}, append() {}, focus() {}, select() {}, replaceChildren() {} });
  const messages = [];
  let refreshes = 0;
  const ctx = {
    sessionResponses: createResponseEpoch(), state: { user: { id: 1, role: 'admin' }, usersLoaded: false },
    byId: (id) => (id === 'invite-code' ? box : node()), element: () => node(),
    message: (text) => messages.push(text), api: (url) => {
      if (url === '/api/admin/invitations') { refreshes++; return Promise.resolve({ items: [] }); }
      return pending.promise;
    },
    location: { origin: 'https://anime.example' }, navigator: {},
  };
  Object.assign(ctx, createAdminController(ctx));
  return { ctx, box, messages, refreshes: () => refreshes };
}

test('an invite link that arrives after sign-out is not shown', async () => {
  const pending = deferred();
  const { ctx, box, messages } = context(pending);
  const creating = ctx.createInviteLink();
  // Sign-out ends the session generation while the request is in flight.
  ctx.sessionResponses.invalidate();
  ctx.state.user = null;
  pending.resolve({ code: 'a'.repeat(64) });
  await creating;
  assert.equal(box.hidden, true, 'the share box stays hidden on the signed-out screen');
  assert.deepEqual(box.children, []);
  assert.deepEqual(messages, []);
});

test('an invite link for the current session is shown', async () => {
  const pending = deferred();
  const { ctx, box, messages, refreshes } = context(pending);
  ctx.state.usersLoaded = true;
  const creating = ctx.createInviteLink();
  pending.resolve({ code: 'b'.repeat(64) });
  await creating;
  assert.equal(box.hidden, false);
  assert.deepEqual(messages, ['Invitation link ready.']);
  assert.equal(refreshes(), 1, 'the open invitation list includes the new link');
});
