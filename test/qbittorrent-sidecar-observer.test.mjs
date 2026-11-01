import assert from 'node:assert/strict';
import test from 'node:test';
import { createQbittorrentSidecarObserver } from
  '../src/availability/qbittorrent-sidecar-observer.mjs';

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

test('rejected sidecar session stays held without a login storm', async () => {
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
  assert.equal(logins, 1);
  assert.equal(requests, 1);
});
