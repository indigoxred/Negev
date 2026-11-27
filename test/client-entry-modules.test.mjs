import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the real browser module graph initializes once and handles the signed-out startup', () => {
  const result = JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL('./helpers/client-entry-probe.mjs', import.meta.url))], { encoding: 'utf8' }));
  assert.equal(result.signedOut, true);
  assert.equal(new Set(result.listeners.filter(x => x.includes('form:submit'))).size,
    result.listeners.filter(x => x.includes('form:submit')).length, 'no duplicate form wiring');
  const index = target => result.listeners.indexOf(target);
  assert.ok(index('login-form:submit') >= 0);
  assert.ok(index('login-form:submit') < index('register-form:submit'));
  assert.ok(index('register-form:submit') < index('signout:click'));
  assert.ok(index('invite:click') < index('reset-form:submit'));
  assert.ok(index('reset-form:submit') < index('refresh-invites:click'));
  assert.ok(index('refresh-invites:click') < index('refresh-users:click'));
});
