import test from 'node:test';
import assert from 'node:assert/strict';
import { startShokoSignalRFeed } from '../src/availability/shoko-signalr-feed.mjs';

const fakeConnection = ({ joined = ['file'] } = {}) => {
  const handlers = new Map();
  const lifecycle = new Map();
  const calls = [];
  return {
    handlers, lifecycle, calls,
    on(name, handler) { handlers.set(name, handler); },
    off(name) { handlers.delete(name); },
    onreconnecting(handler) { lifecycle.set('reconnecting', handler); },
    onreconnected(handler) { lifecycle.set('reconnected', handler); },
    onclose(handler) { lifecycle.set('close', handler); },
    async start() { calls.push(['start']); },
    async invoke(name, ...args) {
      calls.push(['invoke', name, ...args]);
      if (name === 'feed.join_single') {
        assert.deepEqual(args, ['file', null]);
        return true;
      }
      assert.equal(name, 'feed.list_joined');
      assert.deepEqual(args, []);
      return joined;
    },
    async stop() { calls.push(['stop']); },
  };
};

test('subscriber joins Shoko file feed and forwards exact file events', async () => {
  const connection = fakeConnection();
  const events = [];
  const flags = [];
  const feed = await startShokoSignalRFeed({ baseUrl: 'http://shoko:8111/',
    apiKey: 'synthetic-key', consumer: { accept: (...args) => events.push(args),
      flagReconciliation: (reason) => flags.push(reason) },
    createConnection: ({ url, accessTokenFactory }) => {
      assert.equal(url, 'http://shoko:8111/signalr/aggregate');
      assert.equal(accessTokenFactory(), 'synthetic-key');
      return connection;
    } });
  assert.deepEqual(connection.calls.slice(0, 3),
    [['start'], ['invoke', 'feed.join_single', 'file', null],
      ['invoke', 'feed.list_joined']]);
  connection.handlers.get('file:hashed')({ FileID: 42 });
  assert.deepEqual(events, [['file:hashed', [{ FileID: 42 }]]]);
  assert.deepEqual(flags, ['feed_started']);
  await feed.close();
  assert.equal(connection.calls.at(-1)[0], 'stop');
  assert.equal(connection.handlers.size, 0);
});

test('refused feed fails closed and disconnects', async () => {
  const connection = fakeConnection({ joined: [] });
  await assert.rejects(startShokoSignalRFeed({ baseUrl: 'http://shoko:8111/',
    apiKey: 'synthetic-key', consumer: { accept() {}, flagReconciliation() {} },
    createConnection: () => connection }), /Shoko file feed unavailable/);
  assert.equal(connection.calls.at(-1)[0], 'stop');
});

test('reconnection and terminal close flag missing-event reconciliation', async () => {
  const connection = fakeConnection();
  const flags = [];
  const feed = await startShokoSignalRFeed({ baseUrl: 'http://shoko:8111/',
    apiKey: 'synthetic-key', consumer: { accept() {},
      flagReconciliation: (reason) => flags.push(reason) },
    createConnection: () => connection });
  connection.lifecycle.get('reconnecting')();
  await connection.lifecycle.get('reconnected')();
  connection.lifecycle.get('close')();
  assert.equal(typeof feed.closed?.then, 'function');
  await feed.closed;
  assert.deepEqual(flags, ['feed_started', 'feed_disconnected',
    'feed_reconnected', 'feed_disconnected']);
  assert.equal(connection.calls.filter((call) => call[0] === 'invoke').length, 4);
  await feed.close();
});

test('invalid endpoint or missing consumer prevents a connection', async () => {
  let calls = 0;
  await assert.rejects(startShokoSignalRFeed({ baseUrl: 'http://shoko:8111/path',
    apiKey: 'synthetic-key', consumer: { accept() {}, flagReconciliation() {} },
    createConnection: () => { calls++; } }), TypeError);
  assert.equal(calls, 0);
});
