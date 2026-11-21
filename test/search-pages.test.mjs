import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchPager } from '../src/web/public/search-pages.mjs';

const item = (id) => ({ anidbId: id, title: `Anime ${id}` });

test('pages a stable catalogue search without duplicating titles', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 3, items: [item(1), item(2)] });
  assert.equal(pager.nextPage, 2);
  assert.deepEqual(pager.append({ state: 'results', page: 2,
    total: 3, items: [item(3)] }), { state: 'appended', items: [item(3)] });
  assert.equal(pager.nextPage, null);
  assert.deepEqual(pager.items, [item(1), item(2), item(3)]);
});

test('holds changed totals, repeated IDs and empty continuation pages', () => {
  for (const changed of [
    { state: 'results', page: 2, total: 4, items: [item(3)] },
    { state: 'results', page: 2, total: 3, items: [item(1)] },
    { state: 'results', page: 2, total: 3, items: [] },
    { state: 'results', page: 3, total: 3, items: [item(3)] },
  ]) {
    const pager = createSearchPager({ state: 'results', page: 1,
      total: 3, items: [item(1), item(2)] });
    assert.deepEqual(pager.append(changed), { state: 'held' });
    assert.equal(pager.nextPage, 2);
  }
});

test('a fallback source cannot be spliced into a dump search page', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 3, catalogueSource: 'anidb_dump', items: [item(1), item(2)] });
  assert.deepEqual(pager.append({ state: 'results', page: 2,
    total: 3, catalogueSource: 'shoko_cache', items: [item(3)] }),
  { state: 'held' });
});

test('empty search has no further page', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 0, items: [] });
  assert.equal(pager.nextPage, null);
});

test('continuations start two screens ahead, once, with a bounded bottom-only lead', async () => {
  const { observeCatalogueContinuation } = await import('../src/web/public/search-pages.mjs');
  assert.equal(typeof observeCatalogueContinuation, 'function');
  for (const [height, margin] of [[844, '0px 0px 1688px 0px'],
    [900, '0px 0px 1800px 0px'], [8000, '0px 0px 2400px 0px']]) {
    let notify;
    let observed;
    let options;
    let disconnected = 0;
    let loads = 0;
    const marker = {};
    class Observer {
      constructor(callback, settings) { notify = callback; options = settings; }
      observe(target) { observed = target; }
      disconnect() { disconnected++; }
    }
    observeCatalogueContinuation(marker, () => { loads++; }, height, Observer);
    assert.equal(observed, marker);
    assert.equal(options.rootMargin, margin);
    notify([{ isIntersecting: false }]);
    assert.equal(loads, 0, 'no page outside the bounded lead');
    notify([{ isIntersecting: true }]);
    notify([{ isIntersecting: true }]);
    assert.equal(loads, 1, 'queued observer callbacks cannot start concurrent copies');
    assert.equal(disconnected, 1);
  }
});

test('discarded continuation observers cannot load after route or filter changes', async () => {
  const { observeCatalogueContinuation } = await import('../src/web/public/search-pages.mjs');
  assert.equal(typeof observeCatalogueContinuation, 'function');
  let notify;
  let loads = 0;
  class Observer {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  }
  const control = observeCatalogueContinuation({}, () => { loads++; }, 844, Observer);
  control.disconnect();
  notify([{ isIntersecting: true }]);
  assert.equal(loads, 0, 'a queued intersection must not revive an abandoned page');
});
