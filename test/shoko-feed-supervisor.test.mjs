import assert from 'node:assert/strict';
import test from 'node:test';
import { createShokoFeedSupervisor } from
  '../src/availability/shoko-feed-supervisor.mjs';

test('initial Shoko feed outage does not stop the host and retries later', async () => {
  const timers = [];
  let calls = 0;
  const gaps = [];
  const supervisor = createShokoFeedSupervisor({
    connect: async () => { calls++; throw new Error('Shoko offline'); },
    onGap: (reason) => gaps.push(reason),
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  supervisor.start();
  assert.equal(calls, 0);
  const first = timers.shift();
  assert.equal(first.delay, 0);
  await first.fn();
  assert.equal(calls, 1);
  assert.deepEqual(gaps, ['feed_disconnected']);
  assert.equal(timers[0].delay, 5 * 60_000);
  await timers.shift().fn();
  assert.equal(calls, 2);
  await supervisor.close();
});

test('terminal feed close schedules reconnect and shutdown closes current feed', async () => {
  const timers = [];
  const gaps = [];
  let disconnect;
  let closeCalls = 0;
  let connections = 0;
  const supervisor = createShokoFeedSupervisor({
    connect: async () => {
      connections++;
      return { closed: new Promise((resolve) => { disconnect = resolve; }),
        async close() { closeCalls++; } };
    },
    onGap: (reason) => gaps.push(reason),
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  supervisor.start();
  await timers.shift().fn();
  assert.equal(connections, 1);
  disconnect();
  await Promise.resolve();
  assert.deepEqual(gaps, ['feed_disconnected']);
  assert.equal(timers[0].delay, 5 * 60_000);
  await timers.shift().fn();
  assert.equal(connections, 2);
  await supervisor.close();
  assert.equal(closeCalls, 1);
  disconnect();
  await Promise.resolve();
  assert.equal(timers.length, 0);
});
