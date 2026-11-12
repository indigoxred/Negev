import assert from 'node:assert/strict';
import test from 'node:test';
import { createQbittorrentSidecarObserver } from
  '../src/availability/qbittorrent-sidecar-observer.mjs';
import { createQbittorrentSessionGate } from
  '../src/acquisition/qbittorrent-session-gate.mjs';
import { createAcquisitionSessionRunners } from
  '../src/acquisition/acquisition-session-runners.mjs';

const hash = 'a'.repeat(40);

test('sidecar observer logs in once and reads only an exact torrent hash', async () => {
  let logins = 0;
  const urls = [];
  const observer = createQbittorrentSidecarObserver({
    baseUrl: 'http://qbit.internal:8080', username: 'observer',
    password: 'synthetic-password',
    login: async () => { logins++; return { state: 'authenticated',
      sessionId: 'syntheticSid' }; },
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(init.headers.Cookie, 'SID=syntheticSid');
      return new Response(JSON.stringify([{ hash, state: 'missingFiles' }]));
    },
  });
  assert.equal((await observer.readTorrent(hash)).hash, hash);
  assert.equal((await observer.readTorrent(hash)).hash, hash);
  assert.equal(logins, 1);
  assert.deepEqual(urls, Array(2).fill(
    `http://qbit.internal:8080/api/v2/torrents/info?hashes=${hash}`));
});

test('modern qBittorrent cookie is sent unchanged on the exact sidecar read', async () => {
  const observer = createQbittorrentSidecarObserver({
    baseUrl: 'http://qbit.internal:8080', username: 'observer',
    password: 'synthetic-password',
    login: async () => ({ state: 'authenticated',
      sessionId: 'QBT_SID_8080=modern_123' }),
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Cookie, 'QBT_SID_8080=modern_123');
      return Response.json([{ hash, state: 'missingFiles' }]);
    },
  });
  assert.equal((await observer.readTorrent(hash)).hash, hash);
});

test('rejected sidecar session retries once, then backs off repeated 403s', async () => {
  let logins = 0;
  let requests = 0;
  const observer = createQbittorrentSidecarObserver({
    baseUrl: 'http://qbit.internal:8080', username: 'observer',
    password: 'synthetic-password',
    login: async () => { logins++; return { state: 'authenticated',
      sessionId: 'syntheticSid' }; },
    fetchImpl: async () => { requests++; return new Response(null,
      { status: 403 }); },
  });
  assert.equal(await observer.readTorrent(hash), null);
  assert.equal(await observer.readTorrent(hash), null);
  assert.equal(await observer.readTorrent(hash), null);
  assert.equal(logins, 2);
  assert.equal(requests, 2);
});

test('invalid sidecar hash never authenticates or contacts qBittorrent', async () => {
  let networkCalls = 0;
  const observer = createQbittorrentSidecarObserver({
    baseUrl: 'http://qbit.internal:8080', username: 'observer',
    password: 'synthetic-password',
    login: async () => { networkCalls++; return { state: 'authenticated',
      sessionId: 'syntheticSid' }; },
    fetchImpl: async () => { networkCalls++; return Response.json([]); },
  });
  assert.equal(await observer.readTorrent('../wrong'), null);
  assert.equal(networkCalls, 0);
});

test('sidecar and acquisition share one immediate session recovery', async () => {
  let logins = 0;
  let requests = 0;
  const baseUrl = 'http://qbit.internal:8080';
  const gate = createQbittorrentSessionGate({ baseUrl,
    username: 'observer', password: 'synthetic-password',
    login: async () => { logins++; return { state: 'authenticated',
      sessionId: 'sharedSid' }; } });
  const fetchImpl = async () => { requests++;
    return new Response(null, { status: 403 }); };
  const observer = createQbittorrentSidecarObserver({ baseUrl,
    sessionGate: gate, fetchImpl });
  assert.throws(() => createQbittorrentSidecarObserver({ baseUrl,
    sessionGate: gate, username: 'other', fetchImpl }), TypeError);
  const runners = createAcquisitionSessionRunners({ qbBaseUrl: baseUrl,
    sessionGate: gate, fetchImpl,
    processRequest: async () => ({ state: 'held', reason: 'no_candidate' }),
    processStart: async () => ({ state: 'held', reason: 'no_start' }),
    processCompletion: async () => ({ state: 'held', reason: 'no_completion' }),
    processPublish: async () => ({ state: 'held', reason: 'no_publish' }),
  });
  assert.equal((await runners.processRequest({ requestId: 1 })).reason,
    'no_candidate');
  assert.equal(await observer.readTorrent(hash), null);
  assert.equal((await runners.processStart({ attemptId: 2 })).reason,
    'no_start');
  assert.equal(logins, 2);
  assert.equal(requests, 1);
});
