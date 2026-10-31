import assert from 'node:assert/strict';
import test from 'node:test';
import { createAvailabilityCycle } from
  '../src/availability/availability-cycle.mjs';

test('direct Shoko changes get priority without starving a title job', async () => {
  const calls = [];
  const cycle = createAvailabilityCycle({
    runDirect: async () => { calls.push('direct'); return { state: 'checked' }; },
    runTitle: async () => { calls.push('title'); return { state: 'target_checked' }; },
  });
  for (let i = 0; i < 8; i++) await cycle.runOnce();
  assert.deepEqual(calls, ['direct', 'direct', 'direct', 'title',
    'direct', 'direct', 'direct', 'title']);
});

test('an idle preferred queue gives its slot to the other queue', async () => {
  const calls = [];
  const cycle = createAvailabilityCycle({
    runDirect: async () => { calls.push('direct'); return { state: 'idle' }; },
    runTitle: async () => { calls.push('title'); return { state: 'page_loaded' }; },
  });
  assert.equal((await cycle.runOnce()).state, 'page_loaded');
  assert.deepEqual(calls, ['direct', 'title']);
});
