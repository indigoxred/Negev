import assert from 'node:assert/strict';
import test from 'node:test';
import { createQbittorrentSessionFetch } from
  '../src/acquisition/qbittorrent-session-fetch.mjs';
import { observeStoppedManifest } from
  '../src/acquisition/observe-stopped-manifest.mjs';

const baseUrl = 'http://qbit.internal:8080/';
const sessionId = 'sid_123';

test('qBittorrent 403 invalidates only the matching SID', async () => {
  const invalidated = [];
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: (sid) => { invalidated.push(sid); } },
    fetchImpl: async () => new Response('Forbidden', { status: 403 }),
  });
  const result = await scopedFetch(new URL('/api/v2/torrents/info', baseUrl), {
    headers: { Cookie: `SID=${sessionId}` }, method: 'GET', redirect: 'manual',
  });
  assert.equal(result.status, 403);
  assert.deepEqual(invalidated, [sessionId]);
});

test('another service 403 does not invalidate the qBittorrent session', async () => {
  const invalidated = [];
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: (sid) => { invalidated.push(sid); } },
    fetchImpl: async () => new Response('Forbidden', { status: 403 }),
  });
  assert.equal((await scopedFetch('http://shoko.internal/api/v3/File', {
    headers: { 'X-Api-Key': 'synthetic' }, method: 'GET',
  })).status, 403);
  assert.deepEqual(invalidated, []);
});

test('a qBittorrent SID cannot be forwarded to another origin', async () => {
  let calls = 0;
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: () => {} },
    fetchImpl: async () => { calls++; return new Response('Ok.'); },
  });
  await assert.rejects(() => scopedFetch('http://other.internal/api/v2/torrents/info', {
    headers: { Cookie: `SID=${sessionId}` }, method: 'GET',
  }), TypeError);
  assert.equal(calls, 0);
});

test('noncanonical and Request-carried cookies cannot bypass SID scoping', async () => {
  let calls = 0;
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: () => {} },
    fetchImpl: async () => { calls++; return new Response('Ok.'); },
  });
  await assert.rejects(() => scopedFetch('http://other.internal/api/v2/torrents/info', {
    headers: { Cookie: `SID=${sessionId}; extra=1` }, method: 'GET',
  }), TypeError);
  await assert.rejects(() => scopedFetch(new Request(
    'http://other.internal/api/v2/torrents/info', {
      headers: { Cookie: `SID=${sessionId}` }, method: 'GET',
    })), TypeError);
  assert.equal(calls, 0);
});

test('an authenticated qBittorrent call cannot follow a redirect', async () => {
  let calls = 0;
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: () => {} },
    fetchImpl: async () => { calls++; return new Response('Ok.'); },
  });
  await assert.rejects(() => scopedFetch(new URL('/api/v2/torrents/info', baseUrl), {
    headers: { Cookie: `SID=${sessionId}` }, method: 'GET',
  }), TypeError);
  assert.equal(calls, 0);
});

test('successful qBittorrent calls leave the cached session intact', async () => {
  let calls = 0;
  const scopedFetch = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: () => { throw Error('unexpected invalidation'); } },
    fetchImpl: async () => { calls++; return Response.json([]); },
  });
  assert.equal((await scopedFetch(new URL('/api/v2/torrents/info', baseUrl), {
    headers: { Cookie: `SID=${sessionId}` }, method: 'GET', redirect: 'manual',
  })).status, 200);
  assert.equal(calls, 1);
});

test('a stopped-manifest 403 holds and invalidates without another API call', async () => {
  let calls = 0;
  const invalidated = [];
  const fetchImpl = createQbittorrentSessionFetch({ baseUrl, sessionId,
    sessionGate: { invalidate: (sid) => { invalidated.push(sid); } },
    fetchImpl: async () => { calls++;
      return new Response('Forbidden', { status: 403 }); },
  });
  const hash = 'a'.repeat(40);
  const result = await observeStoppedManifest({ baseUrl, sessionId,
    expected: { hash, category: 'negev',
      savePath: `/negev-staging/${hash}` }, fetchImpl });
  assert.deepEqual(result, { state: 'held', reason: 'provider_unavailable' });
  assert.deepEqual(invalidated, [sessionId]);
  assert.equal(calls, 1);
});
