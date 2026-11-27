import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';

const source = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function context(pending) {
  const box = { hidden: true, children: [], replaceChildren(...nodes) { this.children = nodes; } };
  const node = () => ({ addEventListener() {}, setAttribute() {}, append() {}, focus() {}, select() {} });
  const messages = [];
  const ctx = vm.createContext({
    sessionResponses: createResponseEpoch(), state: { user: { id: 1 }, usersLoaded: false },
    byId: (id) => (id === 'invite-code' ? box : node()), element: () => node(),
    message: (text) => messages.push(text), api: () => pending.promise,
    location: { origin: 'https://anime.example' }, navigator: {},
    loadInvites: async () => {},
  });
  vm.runInContext(['showShareLink', 'createInviteLink'].map(functionSource).join('\n') +
    '\nconst linkFor = (kind, code) => `${location.origin}/#${kind}=${code}`;', ctx);
  return { ctx, box, messages };
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
  const { ctx, box, messages } = context(pending);
  let refreshes = 0;
  ctx.state.usersLoaded = true;
  ctx.loadInvites = async () => { refreshes++; };
  const creating = ctx.createInviteLink();
  pending.resolve({ code: 'b'.repeat(64) });
  await creating;
  assert.equal(box.hidden, false);
  assert.deepEqual(messages, ['Invitation link ready.']);
  assert.equal(refreshes, 1, 'the open invitation list includes the new link');
});
