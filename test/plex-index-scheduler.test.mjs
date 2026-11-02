import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlexIndexScheduler } from '../src/availability/plex-index-scheduler.mjs';

test('one page per tick rotates sections and occasionally revisits newest cards', async () => {
  const calls = [];
  const scheduler = createPlexIndexScheduler({
    sections: { episode: [102], movie: [9] }, recentEvery: 3,
    tickPage: async (input) => { calls.push(['page', input]); return { state: 'page_indexed' }; },
    tickRecent: async (input) => { calls.push(['recent', input]); return { state: 'page_indexed' }; },
  });
  for (let i = 0; i < 6; i++) assert.equal((await scheduler.runOnce()).state, 'page_indexed');
  assert.deepEqual(calls, [
    ['page', { kind: 'episode', libraryId: 102 }],
    ['page', { kind: 'movie', libraryId: 9 }],
    ['page', { kind: 'episode', libraryId: 102 }],
    ['page', { kind: 'movie', libraryId: 9 }],
    ['recent', { kind: 'episode', libraryId: 102 }],
    ['recent', { kind: 'movie', libraryId: 9 }],
  ]);
  await scheduler.close();
});

test('overlapping ticks do not create a Plex read backlog', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const scheduler = createPlexIndexScheduler({ sections: { episode: [102], movie: [] },
    tickPage: async () => { entered(); return new Promise((resolve) => { release = resolve; }); },
    tickRecent: async () => ({ state: 'page_indexed' }) });
  const first = scheduler.runOnce();
  await started;
  assert.deepEqual(await scheduler.runOnce(), { state: 'held', reason: 'scheduler_busy' });
  const closing = scheduler.close();
  release({ state: 'page_indexed' });
  await first;
  await closing;
  assert.deepEqual(await scheduler.runOnce(), { state: 'held', reason: 'scheduler_closed' });
});

test('invalid section list and too-fast interval are rejected', () => {
  const base = { sections: { episode: [102], movie: [] },
    tickPage: async () => ({}), tickRecent: async () => ({}) };
  assert.throws(() => createPlexIndexScheduler({ ...base,
    sections: { episode: [102, 102], movie: [] } }), TypeError);
  assert.throws(() => createPlexIndexScheduler({ ...base,
    intervalMs: 1000 }), TypeError);
  assert.doesNotThrow(() => createPlexIndexScheduler({ ...base,
    intervalMs: 15_000 }));
  assert.throws(() => createPlexIndexScheduler({ ...base,
    intervalMs: 14_999 }), TypeError);
});
