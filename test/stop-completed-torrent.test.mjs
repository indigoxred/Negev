import assert from 'node:assert/strict';
import test from 'node:test';
import { stopCompletedTorrent } from '../src/acquisition/stop-completed-torrent.mjs';

const expected = { hash: 'a'.repeat(40), category: 'negev',
  savePath: `/NegevPure/${'a'.repeat(40)}` };
const complete = { state: 'complete', files: [{ index: 0, name: '01.mkv', size: 3 }],
  subtitles: [] };

test('checks exact completion, stops only that hash, then confirms stopped completion', async () => {
  const calls = [];
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async (input) => { calls.push(input.requireStopped === true ? 'after' : 'before');
      return complete; },
    fetchImpl: async (url, init) => {
      calls.push('stop');
      assert.equal(new URL(url).pathname, '/api/v2/torrents/stop');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Cookie, 'SID=testSID');
      assert.equal(new URLSearchParams(init.body).get('hashes'), expected.hash);
      return { status: 200 };
    },
  });
  assert.deepEqual(calls, ['before', 'stop', 'after']);
  assert.deepEqual(result, complete);
});

test('an incomplete torrent never receives stop', async () => {
  let called = false;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async () => ({ state: 'held', reason: 'incomplete' }),
    fetchImpl: async () => { called = true; throw Error('unexpected stop'); },
  });
  assert.deepEqual(result, { state: 'held', reason: 'incomplete' });
  assert.equal(called, false);
});

test('rechecks a delayed stopped state without sending a second stop', async () => {
  let stops = 0;
  let observations = 0;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async ({ requireStopped }) => {
      observations++;
      return requireStopped && observations === 2
        ? { state: 'held', reason: 'torrent_not_stopped' } : complete;
    },
    fetchImpl: async () => { stops++; return { status: 200 }; },
  });
  assert.deepEqual(result, complete);
  assert.equal(stops, 1);
  assert.equal(observations, 3);
});

test('allows a few seconds for qBittorrent to settle after one acknowledged stop', async () => {
  let stops = 0;
  let observations = 0;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async ({ requireStopped }) => {
      observations++;
      return requireStopped && observations < 6
        ? { state: 'held', reason: 'torrent_not_stopped' } : complete;
    },
    fetchImpl: async () => { stops++; return { status: 200 }; },
  });
  assert.deepEqual(result, complete);
  assert.equal(stops, 1);
  assert.equal(observations, 6);
});

test('403 holds without moving and permits one session renewal on the next tick', async () => {
  let stops = 0;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async () => complete,
    fetchImpl: async () => { stops++; return { status: 403 }; },
  });
  assert.deepEqual(result, { state: 'held', reason: 'provider_http_403' });
  assert.equal(stops, 1);
});

test('an initial 403 renews once before stopping the exact completed torrent', async () => {
  let renewals = 0;
  let stops = 0;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async ({ sessionId }) => sessionId === 'testSID'
      ? { state: 'held', reason: 'provider_http_403' } : complete,
    renewQbittorrent: async (sessionId) => {
      assert.equal(sessionId, 'testSID');
      renewals++;
      return { state: 'authenticated', sessionId: 'renewedSID',
        fetchImpl: async (url, init) => {
          stops++;
          assert.equal(init.headers.Cookie, 'SID=renewedSID');
          return { status: 200 };
        } };
    },
  });
  assert.deepEqual(result, complete);
  assert.equal(renewals, 1);
  assert.equal(stops, 1);
});

test('a 403 after stop renews only for observation, never posts a second stop', async () => {
  let renewals = 0;
  let stops = 0;
  const result = await stopCompletedTorrent({
    baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID', expected,
    observe: async ({ sessionId, requireStopped }) =>
      requireStopped && sessionId === 'testSID'
        ? { state: 'held', reason: 'provider_http_403' } : complete,
    fetchImpl: async () => { stops++; return { status: 200 }; },
    renewQbittorrent: async () => {
      renewals++;
      return { state: 'authenticated', sessionId: 'renewedSID',
        fetchImpl: async () => { throw new Error('must not stop again'); } };
    },
  });
  assert.deepEqual(result, complete);
  assert.equal(renewals, 1);
  assert.equal(stops, 1);
});
