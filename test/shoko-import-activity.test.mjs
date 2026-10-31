import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';

const input = { baseUrl: 'http://shoko.local/', apiKey: 'private-test-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('reports unsettled Shoko files without listing private paths', async () => {
  const calls = [];
  const activity = await readShokoImportActivity({ ...input,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method,
        authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/v3/Queue')) return json({
        WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [],
      });
      return json({ Total: 2, List: [{ ID: 1 }] });
    },
  });
  assert.deepEqual(activity, { state: 'unsettled', count: 2 });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('include_only'),
    'Unrecognized,ImportLimbo');
  assert.equal(new URL(calls[1].url).searchParams.get('pageSize'), '1');
  assert.ok(calls.every((call) => call.method === 'GET' &&
    call.authorization === 'Bearer private-test-key'));
});

test('a quiet sample requires an idle queue and zero unsettled files', async () => {
  const quiet = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : json({ Total: 0, List: [] }),
  });
  assert.deepEqual(quiet, { state: 'quiet_observed' });
  const busy = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 1,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : json({ Total: 0, List: [] }),
  });
  assert.deepEqual(busy, { state: 'busy' });
});

test('missing or inconsistent queue and file counts fail closed', async () => {
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
  assert.deepEqual(await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : json({ Total: 0, List: [{ ID: 1 }] }),
  }), { state: 'unavailable' });
});
