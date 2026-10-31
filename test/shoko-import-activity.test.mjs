import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';

const input = { baseUrl: 'http://shoko.local/', apiKey: 'private-test-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('idle queue does not trigger a full Shoko file-list read', async () => {
  const calls = [];
  const activity = await readShokoImportActivity({ ...input,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method,
        authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/v3/Queue')) return json({
        WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [],
      });
      throw new Error('File endpoint must not be queried by an activity probe');
    },
  });
  assert.deepEqual(activity, { state: 'queue_idle_unverified' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v3/Queue');
  assert.ok(calls.every((call) => call.method === 'GET' &&
    call.authorization === 'Bearer private-test-key'));
});

test('idle queue alone never claims that imports are settled', async () => {
  const idle = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : Promise.reject(new Error('Unexpected file query')),
  });
  assert.deepEqual(idle, { state: 'queue_idle_unverified' });
  const busy = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 1,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : Promise.reject(new Error('Unexpected file query')),
  });
  assert.deepEqual(busy, { state: 'busy' });
});

test('missing or inconsistent queue counts fail closed', async () => {
  for (const queue of [
    { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
      TotalCount: 1, CurrentlyExecuting: [], Pools: [] },
    { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
      TotalCount: 0, CurrentlyExecuting: null, Pools: [] },
  ]) {
    const result = await readShokoImportActivity({ ...input,
      fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
        ? json(queue) : json({ Total: 0, List: [] }),
    });
    assert.deepEqual(result, { state: 'unavailable' });
  }
});
