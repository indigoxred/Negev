import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoFilePage } from '../src/availability/shoko-file-page.mjs';
import { readPlexSectionKeys } from '../src/availability/plex-section-keys.mjs';
import { readPlexGuidCards } from '../src/availability/plex-guid-cards.mjs';
import { readPlexLibrarySources } from '../src/availability/plex-library-sources.mjs';
import { readShokoFileCandidate } from '../src/availability/shoko-file-candidate.mjs';
import { readShokoFileIdPage } from '../src/availability/shoko-fileid-catchup.mjs';
import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';
import { readShokoRecentPage } from '../src/availability/shoko-recent-catchup.mjs';

const shoko = { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic' };
const plex = { baseUrl: 'http://plex:32400/', token: 'synthetic', libraryId: 102, kind: 'episode' };
const guidInput = { ...plex, guid: 'tv.plex.agents.custom.shoko://episode/e555' };
const section = { MediaContainer: { librarySectionID: 102,
  Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } };
const emptyPlexPage = { MediaContainer: { librarySectionID: 102, offset: 0, totalSize: 0, size: 0 } };
const sectionRead = response => readPlexSectionKeys({ ...plex, fetchImpl: async url =>
  url.pathname === '/library/sections/102' ? Response.json(section) : response });
const cases = [
  { name: 'Shoko inventory page', read: response => readShokoFilePage({ ...shoko, fetchImpl: async () => response }),
    payload: { Total: 0, List: [] }, success: { state: 'page', page: 1, total: 0, items: [] }, limit: 1_000_000 },
  { name: 'Plex section metadata', read: response => readPlexSectionKeys({ ...plex, fetchImpl: async () => response }),
    payload: { MediaContainer: {} }, success: { state: 'unavailable' }, limit: 100_000 },
  { name: 'Plex section page', read: sectionRead, payload: emptyPlexPage,
    success: { state: 'page', libraryId: 102, kind: 'episode', offset: 0, totalSize: 0, keys: [], complete: false }, limit: 1_000_000 },
  { name: 'Plex GUID cards', read: response => readPlexGuidCards({ ...guidInput, fetchImpl: async () => response }),
    payload: emptyPlexPage, success: { state: 'cards', cards: [], complete: true }, limit: 500_000 },
  { name: 'Plex library sources', read: response => readPlexLibrarySources({ ...plex, libraryIds: [102], fetchImpl: async () => response }),
    payload: { MediaContainer: { size: 1, Directory: [{ key: '102', type: 'show', agent: 'synthetic', scanner: 'synthetic', Location: [{ path: '/anime' }] }] } },
    success: { state: 'source_snapshot', sections: [{ libraryId: 102, type: 'show', agent: 'synthetic', scanner: 'synthetic', roots: ['/anime'] }] }, limit: 500_000 },
  { name: 'Shoko file candidate', read: response => readShokoFileCandidate({ ...shoko, fileId: 51, fetchImpl: async () => response }),
    payload: {}, success: { state: 'unavailable' }, limit: 200_000 },
  { name: 'Shoko file-ID catchup', read: response => readShokoFileIdPage({ ...shoko, fetchImpl: async () => response }),
    payload: { Total: 0, List: [] }, success: { state: 'page', page: 1, total: 0, fileIds: [] }, limit: 1_000_000 },
  { name: 'Shoko import queue', read: response => readShokoImportActivity({ ...shoko, fetchImpl: async () => response }),
    payload: { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0, TotalCount: 0, CurrentlyExecuting: [], Pools: [] },
    success: { state: 'queue_idle_unverified' }, limit: 100_000 },
  { name: 'Shoko recent catchup', read: response => readShokoRecentPage({ ...shoko, fetchImpl: async () => response }),
    payload: { Total: 0, List: [] }, success: { state: 'page', page: 1, total: 0, items: [] }, limit: 1_000_000 },
];
async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('response cleanup blocked observation')), 500);
  })]); } finally { clearTimeout(timer); }
}
function openResponse(status, mode, headers = {}) {
  let cancels = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('unused body')); },
    cancel() {
      cancels++;
      if (mode === 'pending') return new Promise(() => {});
      if (mode === 'reject') return Promise.reject(Error('synthetic cancellation rejection'));
    },
  }), { status, headers });
  if (mode === 'throw') response.body.cancel = () => {
    cancels++; throw Error('synthetic synchronous cancellation failure');
  };
  return { response, cancels: () => cancels };
}
// Missing cancellation at any reader's rejection leaves its real stream open.
for (const scenario of cases) {
  for (const status of [302, 401, 404, 503]) {
    for (const mode of ['normal', 'pending', 'reject', 'throw']) {
      test(`${scenario.name} ${status} discards its body with ${mode} cancellation`, async () => {
        const fixture = openResponse(status, mode);
        assert.deepEqual(await promptly(scenario.read(fixture.response)), { state: 'unavailable' });
        assert.equal(fixture.cancels(), 1, 'unused response body must be cancelled exactly once');
        assert.equal(fixture.response.body.locked, false);
        await new Promise(resolve => setImmediate(resolve));
      });
    }
  }
  test(`${scenario.name} consumes a 200 body before evaluating its existing result`, async () => {
    let cancels = 0;
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(scenario.payload))); controller.close();
    }, cancel() { cancels++; } }));
    assert.deepEqual(await scenario.read(response), scenario.success);
    assert.equal(response.bodyUsed, true);
    assert.equal(response.body.locked, false);
    assert.equal(cancels, 0);
  });
  for (const declared of [false, true]) {
    test(`${scenario.name} keeps bounded cleanup for ${declared ? 'declared' : 'streamed'} oversized 200`, async () => {
      let cancels = 0;
      const response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(scenario.limit + 1)));
      }, cancel() { cancels++; } }), { headers: declared ? { 'content-length': String(scenario.limit + 1) } : {} });
      assert.deepEqual(await promptly(scenario.read(response)), { state: 'unavailable' });
      assert.equal(cancels, 1);
      assert.equal(response.body.locked, false);
    });
  }
}
for (const header of ['x-plex-container-start', 'x-plex-container-total-size']) {
  for (const mode of ['normal', 'pending', 'reject', 'throw']) {
    test(`Plex GUID cards discard unparsed 200 with invalid ${header} and ${mode} cancellation`, async () => {
      const fixture = openResponse(200, mode, { [header]: 'invalid' });
      assert.deepEqual(await promptly(readPlexGuidCards({ ...guidInput, fetchImpl: async () => fixture.response })), { state: 'unavailable' });
      assert.equal(fixture.cancels(), 1);
      assert.equal(fixture.response.body.locked, false);
      await new Promise(resolve => setImmediate(resolve));
    });
  }
}
