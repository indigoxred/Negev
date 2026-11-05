import assert from 'node:assert/strict';
import test from 'node:test';
import { createShokoPosterReader } from '../src/catalogue/shoko-poster-reader.mjs';

const uid = (n) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;

test('Shoko poster grid queues distinct covers and shares identical reads', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const reader = createShokoPosterReader({ baseUrl: 'http://shoko:8111',
    apiKey: 'private-test-key', concurrency: 2, now: () => 1_000,
    fetchImpl: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await hold;
      active--;
      return new Response(Buffer.from([0xff, 0xd8, 0xff]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  const reads = [uid(1), uid(1), uid(2), uid(3)].map((id) =>
    reader.read({ uid: id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  assert.ok((await Promise.all(reads)).every((result) => result.state === 'image'));
  assert.equal(calls, 3);
  await reader.read({ uid: uid(1) });
  assert.equal(calls, 3, 'cover remains cached');
});

test('Shoko poster cache evicts bytes above its budget', async () => {
  let calls = 0;
  const reader = createShokoPosterReader({ baseUrl: 'http://shoko:8111',
    apiKey: 'private-test-key', maxCacheBytes: 5, now: () => 1_000,
    fetchImpl: async () => {
      calls++;
      return new Response(Buffer.from([0xff, 0xd8, 0xff]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  await reader.read({ uid: uid(1) });
  await reader.read({ uid: uid(2) });
  await reader.read({ uid: uid(1) });
  assert.equal(calls, 3);
});
