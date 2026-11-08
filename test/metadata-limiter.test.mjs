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

test('one reserved operation gets the next slot without concurrent reads', async () => {
  const limiter = createMetadataLimiter();
  let release;
  const order = [];
  const first = limiter.run(() => new Promise((resolve) => {
    order.push('first'); release = resolve;
  }));
  const reserved = limiter.runReserved(() => {
    order.push('reserved');
    return { state: 'quiet_observed' };
  });
  assert.deepEqual(await limiter.run(() => order.push('unwanted')),
    { state: 'busy' });
  assert.deepEqual(await limiter.runReserved(() => order.push('second')),
    { state: 'busy' });
  release({ state: 'done' });
  assert.deepEqual(await first, { state: 'done' });
  assert.deepEqual(await reserved, { state: 'quiet_observed' });
  assert.deepEqual(order, ['first', 'reserved']);
  assert.equal(await limiter.run(() => 'after'), 'after');
});

test('timed-out reservation releases its slot without running', async () => {
  const limiter = createMetadataLimiter();
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  let ran = false;
  assert.deepEqual(await limiter.runReserved(() => { ran = true; }, 5),
    { state: 'busy' });
  assert.equal(ran, false);
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await limiter.run(() => 'next'), 'next');
});
