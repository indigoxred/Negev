import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthController } from '../src/web/public/auth-controller.mjs';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';

function fixture(overrides = {}) {
  const nodes = new Map(), messages = [];
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, value: '', classList: { toggle() {} },
      elements: { code: {}, username: { focus() {} }, password: { focus() {} } } });
    return nodes.get(id);
  };
  const controller = createAuthController({ byId, message: text => messages.push(text),
    api: async () => ({ username: 'Member' }), state: { user: null },
    sessionResponses: createResponseEpoch(), refreshSession: async () => true,
    clearWorkspace() {}, location: { hash: '', pathname: '/', search: '' }, history: {},
    FormData: class { get() { return 'fixture'; } }, ...overrides });
  return { controller, byId, messages };
}

for (const [formId, handler] of [['login-form', 'handleLoginSubmit'],
  ['register-form', 'handleRegisterSubmit'], ['reset-form', 'handleResetSubmit']]) {
  test(`${formId} retains the form after event.currentTarget becomes null`, async () => {
    let resolve; const pending = new Promise(r => { resolve = r; });
    const f = fixture({ api: () => pending });
    let resets = 0;
    const event = { preventDefault() {}, currentTarget: { reset() { resets++; } } };
    const submit = f.controller[handler](event);
    event.currentTarget = null;
    resolve({ username: 'Member' }); await submit;
    assert.equal(resets, 1);
    assert.ok(f.messages.some(message => /Signed in|Account created|Password changed/.test(message)));
  });
}

test('an invitation fragment is removed from the URL and consumed only once', () => {
  const replacements = [];
  const f = fixture({ location: { hash: '#invite=' + 'a'.repeat(64), pathname: '/', search: '?x=1' },
    history: { replaceState: (...args) => replacements.push(args) } });
  assert.equal(f.controller.pendingLink.kind, 'invite');
  assert.deepEqual(replacements, [[null, '', '/?x=1']]);
  f.controller.applyPendingLinkCode();
  assert.equal(f.byId('register-form').elements.code.value, 'a'.repeat(64));
  assert.equal(f.controller.pendingLink, null);
  const messages = f.messages.length;
  f.controller.applyPendingLinkCode();
  assert.equal(f.messages.length, messages);
});
