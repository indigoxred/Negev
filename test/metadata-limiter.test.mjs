import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetadataLimiter } from '../src/web/metadata-limiter.mjs';

test('only one provider operation runs and busy requests do not queue', async () => {
  const limiter = createMetadataLimiter();
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  let invoked = false;
  assert.deepEqual(await limiter.run(() => { invoked = true; }),
    { state: 'busy' });
  assert.equal(invoked, false);
  release({ state: 'results' });
  assert.deepEqual(await first, { state: 'results' });
  assert.deepEqual(await limiter.run(() => ({ state: 'ready' })),
    { state: 'ready' });
});

test('provider failure releases the admission slot', async () => {
  const limiter = createMetadataLimiter();
  await assert.rejects(limiter.run(() => { throw new Error('provider outage'); }));
  assert.equal(await limiter.run(() => 7), 7);
});
