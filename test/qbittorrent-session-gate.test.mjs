import assert from 'node:assert/strict';
import test from 'node:test';
import { createQbittorrentSessionGate } from
  '../src/acquisition/qbittorrent-session-gate.mjs';

test('bad credentials are attempted once and remain held until restart', async () => {
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => { calls++; return { state: 'held', reason: 'authentication_failed' }; },
    now: () => 1_000,
  });
  assert.deepEqual(await gate.get(), { state: 'held', reason: 'authentication_failed' });
  assert.deepEqual(await gate.get(), { state: 'held', reason: 'authentication_failed' });
  assert.equal(calls, 1);
  assert.deepEqual(gate.getStatus(), { state: 'credentials_rejected', retryAtMs: null });
});

test('transient login failure backs off without a retry loop', async () => {
  let time = 1_000;
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => ++calls === 1
      ? { state: 'held', reason: 'authentication_unavailable' }
      : { state: 'authenticated', sessionId: 'sid_123' },
    now: () => time, retryDelayMs: 30_000,
  });
  assert.equal((await gate.get()).reason, 'authentication_unavailable');
  time = 30_999;
  assert.deepEqual(await gate.get(), { state: 'held', reason: 'authentication_backoff' });
  assert.equal(calls, 1);
  time = 31_000;
  assert.deepEqual(await gate.get(), { state: 'authenticated', sessionId: 'sid_123' });
  assert.equal(calls, 2);
});

test('concurrent workers share one login and a cached session', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => { calls++; await pending;
      return { state: 'authenticated', sessionId: 'sid_123' }; },
    now: () => 1_000,
  });
  const first = gate.get();
  const second = gate.get();
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { state: 'authenticated', sessionId: 'sid_123' },
    { state: 'authenticated', sessionId: 'sid_123' },
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(await gate.get(), { state: 'authenticated', sessionId: 'sid_123' });
  assert.equal(calls, 1);
});

test('a rejected session is cleared and paced before login again', async () => {
  let time = 1_000;
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => { calls++;
      return { state: 'authenticated', sessionId: `sid_${calls}` }; },
    now: () => time, retryDelayMs: 30_000,
  });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  assert.deepEqual(gate.invalidate('sid_other'), { state: 'held', reason: 'session_mismatch' });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  assert.deepEqual(gate.invalidate('sid_1'), { state: 'invalidated' });
  assert.equal((await gate.get()).reason, 'authentication_backoff');
  time = 61_000;
  assert.equal((await gate.get()).sessionId, 'sid_2');
  assert.equal(calls, 2);
});

test('one rejected cached SID gets a paced recovery, then repeated rejection backs off fully', async () => {
  let time = 1_000;
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => ({ state: 'authenticated', sessionId: `sid_${++calls}` }),
    now: () => time, retryDelayMs: 30 * 60_000,
  });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  assert.deepEqual(gate.invalidate('sid_1'), { state: 'invalidated' });
  time = 60_999;
  assert.equal((await gate.get()).reason, 'authentication_backoff');
  time = 61_000;
  assert.equal((await gate.get()).sessionId, 'sid_2');
  assert.deepEqual(gate.invalidate('sid_2'), { state: 'invalidated' });
  time = 121_000;
  assert.equal((await gate.get()).reason, 'authentication_backoff');
  assert.equal(calls, 2);
  time = 1_861_000;
  assert.equal((await gate.get()).sessionId, 'sid_3');
});

test('renewing an established session before a long hash final check logs in once', async () => {
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => ({ state: 'authenticated', sessionId: `sid_${++calls}` }),
    now: () => 1_000,
  });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  assert.deepEqual(await gate.renew('sid_1'),
    { state: 'authenticated', sessionId: 'sid_2' });
  assert.equal((await gate.get()).sessionId, 'sid_2');
  assert.deepEqual(await gate.renew('sid_1'),
    { state: 'authenticated', sessionId: 'sid_2' });
  assert.equal(calls, 2);
});

test('a cached login is renewed before its known one-hour WebUI lifetime', async () => {
  let time = 1_000;
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => ({ state: 'authenticated', sessionId: `sid_${++calls}` }),
    now: () => time,
  });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  time += 29 * 60_000;
  assert.equal((await gate.get()).sessionId, 'sid_1');
  time += 60_000;
  assert.equal((await gate.get()).sessionId, 'sid_2');
  assert.equal((await gate.get()).sessionId, 'sid_2');
  assert.equal(calls, 2);
});

test('a failed age renewal never falls back to the old session or loops', async () => {
  let time = 1_000;
  let calls = 0;
  const gate = createQbittorrentSessionGate({
    baseUrl: 'http://qbit.internal:8080/', username: 'negev', password: 'secret',
    login: async () => ++calls === 1
      ? { state: 'authenticated', sessionId: 'sid_1' }
      : { state: 'held', reason: 'authentication_unavailable' },
    now: () => time,
  });
  assert.equal((await gate.get()).sessionId, 'sid_1');
  time += 30 * 60_000;
  assert.deepEqual(await gate.get(),
    { state: 'held', reason: 'authentication_unavailable' });
  assert.deepEqual(await gate.get(),
    { state: 'held', reason: 'authentication_backoff' });
  assert.equal(calls, 2);
});
