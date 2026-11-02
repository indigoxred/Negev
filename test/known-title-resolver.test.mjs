import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createObservedTitleRegistry } from '../src/catalogue/observed-title-registry.mjs';
import { createKnownTitleResolver } from '../src/catalogue/known-title-resolver.mjs';

test('a validated catalogue title remains usable after the short observed window expires', async () => {
  let time = 0;
  let refreshes = 0;
  const registry = createObservedTitleRegistry({ now: () => time, ttlMs: 100 });
  const source = {
    refresh: async () => { refreshes++; return { state: 'stale' }; },
    getTitle: (id) => id === 42 ? 'Known title' : null,
  };
  registry.observe({ state: 'results', total: 1,
    items: [{ anidbId: 42, title: 'Known title' }] });
  const confirm = createKnownTitleResolver({ registry, source });
  assert.equal(await confirm({ anidbId: 42 }), true);
  assert.equal(refreshes, 0);
  time = 101;
  assert.equal(await confirm({ anidbId: 42 }), true);
  assert.equal(refreshes, 1);
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), true);
  const restarted = createKnownTitleResolver({
    registry: createObservedTitleRegistry({ now: () => time }), source });
  assert.equal(await restarted({ anidbId: 42 }), true);
  assert.equal(await confirm({ anidbId: 99 }), false);
  assert.equal(await confirm({ anidbId: -1 }), false);
});

test('missing or unvalidated source fails closed', async () => {
  const registry = createObservedTitleRegistry();
  const confirm = createKnownTitleResolver({ registry, source: {
    refresh: async () => ({ state: 'unavailable' }),
    getTitle: () => 'Untrusted title',
  } });
  assert.equal(await confirm({ anidbId: 42 }), false);
});
