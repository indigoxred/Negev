import assert from 'node:assert/strict';
import test from 'node:test';
import { mutateWithDistinctCtime } from './helpers/ctime-fixture.mjs';

test('the mutation fixture retries equal timestamps until a distinct ctime is observed', async () => {
  let edits = 0, waits = 0;
  const after = await mutateWithDistinctCtime({ before: { ctimeNs: 10n },
    mutate: async () => { edits++; },
    readStat: async () => ({ ctimeNs: edits < 4 ? 10n : 11n }),
    wait: async () => { waits++; }, now: () => waits, timeoutMs: 10 });
  assert.equal(edits, 4);
  assert.equal(waits, 3);
  assert.equal(after.ctimeNs, 11n);
});

test('the mutation fixture fails rather than skipping or succeeding when ctime never changes', async () => {
  let time = 0;
  await assert.rejects(() => mutateWithDistinctCtime({ before: { ctimeNs: 10n },
    mutate: async () => {}, readStat: async () => ({ ctimeNs: 10n }),
    wait: async () => { time += 1; }, now: () => time, timeoutMs: 3 }),
  /Fixture mutation did not produce a distinct ctime/);
});

test('the mutation fixture does not hide filesystem errors', async () => {
  const error = new Error('synthetic write refused');
  await assert.rejects(() => mutateWithDistinctCtime({ before: { ctimeNs: 10n },
    mutate: async () => { throw error; }, readStat: async () => assert.fail('no stat after failed edit') }),
  candidate => candidate === error);
});
