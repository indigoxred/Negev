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
        headers: { Cookie: 'SID=session_1' }, redirect: 'manual' });
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

test('completion gets a separate Shoko transport while sharing the qBittorrent session', async () => {
  const calls = [];
  const providerFetch = async (url) => {
    calls.push(String(url));
    return new Response('ok');
  };
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qb:8080/',
    sessionGate: { get: async () => ({ state: 'authenticated',
      sessionId: 'session_1' }), invalidate: () => {} },
    fetchImpl: providerFetch,
    processRequest: async () => ({ state: 'held', reason: 'unused' }),
    processStart: async () => ({ state: 'held', reason: 'unused' }),
    processCompletion: async ({ qbittorrent, fetchImpl,
      shokoFetchImpl }) => {
      assert.equal(qbittorrent.sessionId, 'session_1');
      assert.notEqual(fetchImpl, providerFetch);
      assert.equal(shokoFetchImpl, providerFetch);
      await shokoFetchImpl('http://shoko:8111/api/v3/test');
      return { state: 'held', reason: 'test_only' };
    },
    processPublish: async () => ({ state: 'held', reason: 'unused' }),
  });
  assert.deepEqual(await run.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'test_only' });
  assert.deepEqual(calls, ['http://shoko:8111/api/v3/test']);
});

test('completion can renew one qBittorrent session after hashing without another worker login', async () => {
  const cookies = [];
  let renewals = 0;
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qb:8080/',
    sessionGate: {
      get: async () => ({ state: 'authenticated', sessionId: 'session_1' }),
      renew: async (sid) => { assert.equal(sid, 'session_1'); renewals++;
        return { state: 'authenticated', sessionId: 'session_2' }; },
      invalidate: () => {},
    },
    fetchImpl: async (_url, init) => {
      cookies.push(init.headers.Cookie);
      return new Response('[]');
    },
    processRequest: async () => ({ state: 'held', reason: 'unused' }),
    processStart: async () => ({ state: 'held', reason: 'unused' }),
    processCompletion: async ({ renewQbittorrent }) => {
      const fresh = await renewQbittorrent('session_1');
      await fresh.fetchImpl('http://qb:8080/api/v2/torrents/info', {
        headers: { Cookie: `SID=${fresh.sessionId}` }, redirect: 'manual' });
      return { state: 'held', reason: 'test_only' };
    },
    processPublish: async () => ({ state: 'held', reason: 'unused' }),
  });
  assert.deepEqual(await run.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'test_only' });
  assert.equal(renewals, 1);
  assert.deepEqual(cookies, ['SID=session_2']);
});

test('request can renew its session after a long Import observation', async () => {
  let renewals = 0;
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qb:8080/',
    sessionGate: {
      get: async () => ({ state: 'authenticated', sessionId: 'old_sid' }),
      renew: async (sid) => { assert.equal(sid, 'old_sid'); renewals++;
        return { state: 'authenticated', sessionId: 'new_sid' }; },
      invalidate: () => {},
    },
    fetchImpl: async () => Response.json([]),
    processRequest: async ({ qbittorrent, renewQbittorrent }) => {
      const fresh = await renewQbittorrent(qbittorrent.sessionId);
      return { state: fresh.state, sessionId: fresh.sessionId };
    },
    processStart: async () => ({ state: 'held', reason: 'unused' }),
    processCompletion: async () => ({ state: 'held', reason: 'unused' }),
    processPublish: async () => ({ state: 'held', reason: 'unused' }),
  });
  assert.deepEqual(await run.processRequest({ requestId: 1 }),
    { state: 'authenticated', sessionId: 'new_sid' });
  assert.equal(renewals, 1);
});

test('start can renew a rejected qBittorrent session before sending start', async () => {
  let renewals = 0;
  const run = createAcquisitionSessionRunners({
    qbBaseUrl: 'http://qbittorrent.internal:8080/',
    sessionGate: {
      get: async () => ({ state: 'authenticated', sessionId: 'old_sid' }),
      invalidate: () => {},
      renew: async (sid) => { assert.equal(sid, 'old_sid'); renewals++;
        return { state: 'authenticated', sessionId: 'new_sid' }; },
    },
    fetchImpl: async () => new Response('Ok.'),
    processRequest: async () => {},
    processStart: async ({ qbittorrent, renewQbittorrent }) => {
      const fresh = await renewQbittorrent(qbittorrent.sessionId);
      return { state: fresh.state, sessionId: fresh.sessionId };
    },
    processCompletion: async () => {},
    processPublish: async () => {},
  });
  assert.deepEqual(await run.processStart({ attemptId: 9 }),
    { state: 'authenticated', sessionId: 'new_sid' });
  assert.equal(renewals, 1);
});
