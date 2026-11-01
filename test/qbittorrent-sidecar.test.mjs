import assert from 'node:assert/strict';
import test from 'node:test';
import { readQbittorrentSidecarTorrent } from
  '../src/acquisition/qbittorrent-sidecar.mjs';

const hash = 'a'.repeat(40);
const input = { baseUrl: 'http://qbit.local:8080/', sessionId: 'syntheticSid', hash };
const torrent = { hash, state: 'missingFiles', save_path: '/Shoko',
  category: 'Direct', progress: 0, dlspeed: 0, upspeed: 0,
  force_start: false, last_activity: 1_000 };

test('reads only the exact qBittorrent hash with an authenticated bounded GET', async () => {
  let request;
  const result = await readQbittorrentSidecarTorrent({ ...input,
    fetchImpl: async (url, init) => {
      request = { url: new URL(url), init };
      return Response.json([torrent]);
    },
  });
  assert.deepEqual(result, torrent);
  assert.equal(request.url.pathname, '/api/v2/torrents/info');
  assert.equal(request.url.searchParams.get('hashes'), hash);
  assert.equal(request.init.headers.Cookie, 'SID=syntheticSid');
  assert.equal(request.init.redirect, 'manual');
});

test('missing, duplicated, or changed sidecar torrents never pass', async () => {
  for (const list of [[], [torrent, torrent],
    [{ ...torrent, hash: 'b'.repeat(40) }]]) {
    assert.equal(await readQbittorrentSidecarTorrent({ ...input,
      fetchImpl: async () => Response.json(list) }), null);
  }
  assert.equal(await readQbittorrentSidecarTorrent({ ...input,
    fetchImpl: async () => new Response(null, { status: 302,
      headers: { location: 'https://evil.invalid' } }) }), null);
  await assert.rejects(() => readQbittorrentSidecarTorrent({ ...input,
    hash: 'invalid', fetchImpl: async () => { throw Error('unexpected'); } }), TypeError);
});
