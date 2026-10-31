import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservedTitleRegistry } from '../src/catalogue/observed-title-registry.mjs';

const hit = (id) => ({ state: 'results', total: 1, page: 1,
  items: [{ anidbId: id, title: `Title ${id}`, requestable: false }] });

test('only exact recently observed AniDB IDs are trusted', () => {
  let time = 1_000;
  const registry = createObservedTitleRegistry({ ttlMs: 100, maxEntries: 2, now: () => time });
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), false);
  assert.equal(registry.observe(hit(42)), true);
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), true);
  assert.equal(registry.isKnownTitle({ anidbId: 43 }), false);
  time = 1_100;
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), false);
});

test('malformed search results cannot authorize arbitrary IDs and capacity is bounded', () => {
  const registry = createObservedTitleRegistry({ maxEntries: 2, now: () => 1_000 });
  assert.equal(registry.observe({ ...hit(42), items: [{ anidbId: 42, title: '' }] }), false);
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), false);
  for (const id of [42, 43, 44]) assert.equal(registry.observe(hit(id)), true);
  assert.equal(registry.isKnownTitle({ anidbId: 42 }), false);
  assert.equal(registry.isKnownTitle({ anidbId: 43 }), true);
  assert.equal(registry.isKnownTitle({ anidbId: 44 }), true);
});
