import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';

test('a response started under a previous signed-in account cannot apply later', async () => {
  const account = createResponseEpoch();
  const requests = createResponseEpoch();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const oldAccount = account.current();
  const oldList = requests.invalidate();
  const applied = [];
  const oldFetch = pending.then(() => {
    if (account.isCurrent(oldAccount) && requests.isCurrent(oldList)) {
      applied.push('old account requests');
    }
  });
  account.invalidate();
  requests.invalidate();
  const newAccount = account.current();
  const newList = requests.invalidate();
  release();
  await oldFetch;
  assert.deepEqual(applied, []);
  assert.equal(account.isCurrent(newAccount) && requests.isCurrent(newList), true);
});

test('an older request page cannot overwrite a newer page for the same account', () => {
  const requests = createResponseEpoch();
  const first = requests.invalidate();
  const second = requests.invalidate();
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
});
