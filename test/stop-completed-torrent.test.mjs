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
