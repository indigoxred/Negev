import assert from 'node:assert/strict';
import test from 'node:test';
import { observeStoppedManifest } from '../src/acquisition/observe-stopped-manifest.mjs';

const expected = { hash: 'a'.repeat(40), category: 'negev',
  savePath: `/Downloads/negev/${'a'.repeat(40)}` };
const config = { baseUrl: 'http://qbittorrent.internal:8080', sessionId: 'syntheticSID', expected };
const torrent = { hash: expected.hash, category: 'negev', save_path: expected.savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1_000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Show/01.mkv', size: 1_000, priority: 1, progress: 0 }];
const properties = { save_path: expected.savePath, download_path: '' };

test('reads the exact stopped torrent and file list twice before accepting the manifest', async () => {
  const calls = [];
  const result = await observeStoppedManifest({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    const endpoint = new URL(url).pathname;
    return { status: 200, text: async () => JSON.stringify(endpoint.endsWith('/files')
      ? files : endpoint.endsWith('/properties') ? properties : [torrent]) };
  } });
  assert.deepEqual(calls.map((call) => call.url.pathname), [
    '/api/v2/torrents/info', '/api/v2/torrents/properties', '/api/v2/torrents/files',
    '/api/v2/torrents/info', '/api/v2/torrents/properties', '/api/v2/torrents/files',
  ]);
  assert.equal(calls.every((call) => call.init.method === 'GET' &&
    call.init.headers.Cookie === 'SID=syntheticSID' && call.init.redirect === 'manual'), true);
  assert.equal(calls[0].url.searchParams.get('hashes'), expected.hash);
  assert.equal(calls[1].url.searchParams.get('hash'), expected.hash);
  assert.deepEqual(result, { state: 'manifest_safe', videos: [{ index: 0, name: 'Show/01.mkv', size: 1_000 }], subtitles: [] });
});

test('changed manifest, missing torrent and provider errors hold', async () => {
  const respond = (items) => async () => ({ status: 200, text: async () => JSON.stringify(items.shift()) });
  assert.deepEqual(await observeStoppedManifest({ ...config, fetchImpl: respond([[]]) }),
    { state: 'held', reason: 'torrent_unavailable' });
  assert.deepEqual(await observeStoppedManifest({ ...config,
    fetchImpl: respond([[torrent], properties, files,
      [{ ...torrent, downloaded: 1 }], properties, files]) }),
  { state: 'held', reason: 'torrent_changed' });
  assert.deepEqual(await observeStoppedManifest({ ...config,
    fetchImpl: respond([[torrent], properties, files, [torrent], properties,
      [{ ...files[0], name: 'run.exe' }]]) }),
  { state: 'held', reason: 'manifest_changed' });
  assert.deepEqual(await observeStoppedManifest({ ...config, fetchImpl: async () => ({ status: 403 }) }),
    { state: 'held', reason: 'provider_unavailable' });
});

test('rejects malformed configuration before contacting the downloader', async () => {
  await assert.rejects(() => observeStoppedManifest({ ...config, sessionId: 'bad;cookie',
    fetchImpl: async () => { throw Error('unexpected call'); } }), TypeError);
});

test('holds a stopped torrent whose actual download path escapes staging', async () => {
  const result = await observeStoppedManifest({ ...config,
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname;
      return Response.json(endpoint.endsWith('/files') ? files :
        endpoint.endsWith('/properties')
          ? { save_path: expected.savePath, download_path: '/Shoko Import' }
          : [torrent]);
    } });
  assert.deepEqual(result, { state: 'held', reason: 'incomplete_path_outside_staging' });
});

test('a renamed or added qBittorrent file cannot masquerade as the original metainfo', async () => {
  for (const changed of [[{ ...files[0], name: 'renamed.mkv' }],
    [...files, { index: 1, name: 'readme.nfo', size: 20, priority: 0, progress: 0 }]]) {
    const result = await observeStoppedManifest({ ...config,
      expectedFiles: [{ name: 'Show/01.mkv', size: 1_000 }],
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        return Response.json(endpoint.endsWith('/files') ? changed :
          endpoint.endsWith('/properties') ? properties : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'metainfo_manifest_mismatch' });
  }
});
