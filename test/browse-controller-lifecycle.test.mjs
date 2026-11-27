import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowseFixture } from './helpers/browse-controller-fixture.mjs';

test('leaving a browse route cancels its pending filter submissions', () => {
  const jobs = new Map(); let next = 0;
  const f = createBrowseFixture({ setTimeout: (fn, delay) => { jobs.set(++next, { fn, delay }); return next; },
    clearTimeout: id => jobs.delete(id) });
  f.controller.scheduleFilterApply('season', 100);
  f.controller.scheduleFilterApply('airing', 250);
  assert.equal(jobs.size, 2);
  f.controller.handleFilterRouteChange();
  assert.equal(jobs.size, 0);
});

for (const boundary of ['session', 'route']) {
  test(`a pending library response cannot render across a ${boundary} change`, async () => {
    let resolve; const pending = new Promise(r => { resolve = r; });
    const f = createBrowseFixture({ api: () => pending });
    const reading = f.controller.loadLibrary();
    if (boundary === 'session') { f.deps.sessionResponses.invalidate(); f.deps.state.user = { id: 2 }; }
    else f.deps.location.hash = '#/discover';
    resolve({ items: [{ anidbId: 42, title: 'Old result' }], nextAfterAnidbId: null });
    await reading;
    assert.equal(f.deps.state.libraryLoaded, false);
    assert.deepEqual(f.byId('library-list').children, []);
  });
}
