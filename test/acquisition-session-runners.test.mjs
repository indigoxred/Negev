import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcquisitionSessionRunners } from
  '../src/acquisition/acquisition-session-runners.mjs';

test('three qBittorrent stages share one gate and hold without invoking processors', async () => {
  const calls = [];
  const gate = { get: async () => ({ state: 'held', reason: 'authentication_backoff' }),
    invalidate: () => { throw new Error('not expected'); } };
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qb:8080/', sessionGate: gate,
    fetchImpl: async () => { throw new Error('no network expected'); },
    processRequest: async () => { calls.push('request'); },
    processStart: async () => { calls.push('start'); },
    processCompletion: async () => { calls.push('completion'); },
    processPublish: async () => { calls.push('publish'); return { state: 'published_observed' }; },
  });
  assert.deepEqual(await run.processRequest({ requestId: 1 }),
    { state: 'held', reason: 'authentication_backoff' });
  assert.deepEqual(await run.processStart({ attemptId: 2 }),
    { state: 'held', reason: 'authentication_backoff' });
  assert.deepEqual(await run.processCompletion({ attemptId: 2 }),
    { state: 'held', reason: 'authentication_backoff' });
  assert.deepEqual(calls, []);
  assert.deepEqual(await run.processPublish({ attemptId: 2 }),
    { state: 'published_observed' });
  assert.deepEqual(calls, ['publish']);
});

test('one authenticated session is scoped to qBittorrent and invalidated on 403', async () => {
  const invalidated = [];
  let logins = 0;
  const gate = { get: async () => { logins++;
    return { state: 'authenticated', sessionId: 'session_1' }; },
  invalidate: (sid) => { invalidated.push(sid); } };
  const network = [];
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qb:8080/', sessionGate: gate,
    fetchImpl: async (url, init) => { network.push([String(url), init.headers.Cookie]);
      return new Response('', { status: 403 }); },
    processRequest: async ({ qbittorrent, fetchImpl, requestId }) => {
      assert.deepEqual(qbittorrent,
        { baseUrl: 'http://qb:8080/', sessionId: 'session_1' });
      await fetchImpl(new URL('http://qb:8080/api/v2/torrents/info'), {
        headers: { Cookie: 'SID=session_1' } });
      return { state: 'held', reason: 'provider_unavailable', requestId };
    },
    processStart: async ({ qbittorrent }) => ({ state: 'started',
      sessionId: qbittorrent.sessionId }),
    processCompletion: async () => ({ state: 'held', reason: 'incomplete' }),
    processPublish: async () => ({ state: 'held', reason: 'not_prepared' }),
  });
  assert.deepEqual(await run.processRequest({ requestId: 5 }),
    { state: 'held', reason: 'provider_unavailable', requestId: 5 });
  assert.deepEqual(invalidated, ['session_1']);
  assert.deepEqual(network, [['http://qb:8080/api/v2/torrents/info', 'SID=session_1']]);
  assert.deepEqual(await run.processStart({ attemptId: 6 }),
    { state: 'started', sessionId: 'session_1' });
  assert.equal(logins, 2);
});
