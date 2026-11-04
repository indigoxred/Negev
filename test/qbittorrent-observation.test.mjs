import assert from 'node:assert/strict';
import test from 'node:test';
import { observeTorrentCompletion } from '../src/acquisition/qbittorrent-observation.mjs';

const expected = { hash: 'a'.repeat(40), category: 'negev-test', savePath: '/staging' };
const config = { baseUrl: 'http://qbittorrent.internal:8080', sessionId: 'syntheticSID', expected };
const torrent = { ...expected, save_path: '/staging', state: 'uploading', progress: 1, amount_left: 0,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example/01.mkv', size: 1000, progress: 1, priority: 1, is_seed: true }];
const properties = { save_path: '/staging', download_path: '' };

test('reads only one exact torrent and its files, then rechecks state', async () => {
  const calls = [];
  const result = await observeTorrentCompletion({ ...config, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ parsed, init });
    return { status: 200, text: async () => JSON.stringify(parsed.pathname.endsWith('/files')
      ? files : parsed.pathname.endsWith('/properties') ? properties : [torrent]) };
  } });
  assert.deepEqual(calls.map((call) => call.parsed.pathname), [
    '/api/v2/torrents/info', '/api/v2/torrents/properties', '/api/v2/torrents/files',
    '/api/v2/torrents/info', '/api/v2/torrents/properties', '/api/v2/torrents/files',
  ]);
  assert.equal(calls[0].parsed.searchParams.get('hashes'), expected.hash);
  assert.equal(calls[1].parsed.searchParams.get('hash'), expected.hash);
  assert.equal(calls.every((call) => call.init.method === 'GET' &&
    call.init.headers.Cookie === 'SID=syntheticSID' && call.init.redirect === 'manual'), true);
  assert.deepEqual(result, { state: 'complete',
    files: [{ index: 0, name: 'Example/01.mkv', size: 1000 }], subtitles: [] });
});

test('missing torrent, changed state and selected unsafe files hold', async () => {
  const respond = (items) => async () => ({ status: 200, text: async () => JSON.stringify(items.shift()) });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[]]) }), { state: 'held', reason: 'torrent_unavailable' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], properties, files,
      [{ ...torrent, state: 'downloading' }], properties, files]) }),
  { state: 'held', reason: 'torrent_changed' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], properties, [{ ...files[0], name: 'run.exe' }],
      [torrent], properties, [{ ...files[0], name: 'run.exe' }]]) }),
  { state: 'held', reason: 'unsafe_selected_file' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], properties, files,
      [torrent], properties, [{ ...files[0], priority: 0 }]]) }),
  { state: 'held', reason: 'manifest_changed' });
});

test('completed seeding state may change while the exact file evidence stays stable', async () => {
  const respond = (items) => async () => ({ status: 200,
    text: async () => JSON.stringify(items.shift()) });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], properties, files,
      [{ ...torrent, state: 'stalledUP' }], properties, files]) }),
  { state: 'complete', files: [{ index: 0, name: 'Example/01.mkv', size: 1000 }],
    subtitles: [] });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[{ ...torrent, state: 'downloading' }], properties, files,
      [torrent], properties, files]) }),
  { state: 'held', reason: 'torrent_changed' });
});

test('completion holds if incomplete storage points outside staging or changes', async () => {
  const respond = (items) => async () => ({ status: 200, text: async () => JSON.stringify(items.shift()) });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], { ...properties, download_path: '/public/Import' }, files,
      [torrent], { ...properties, download_path: '/public/Import' }, files]) }),
  { state: 'held', reason: 'incomplete_path_outside_staging' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], properties, files,
      [torrent], { ...properties, download_path: '/staging' }, files]) }),
  { state: 'held', reason: 'storage_path_changed' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: respond([[torrent], {}, files, [torrent], {}, files]) }),
  { state: 'held', reason: 'storage_path_unverified' });
});

test('invalid authentication and provider errors never authorize completion', async () => {
  await assert.rejects(() => observeTorrentCompletion({ ...config, sessionId: 'bad;cookie',
    fetchImpl: async () => { throw Error('must not call'); } }), TypeError);
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: async () => ({ status: 403 }) }), { state: 'held', reason: 'provider_http_403' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); } }),
  { state: 'held', reason: 'provider_timeout' });
  assert.deepEqual(await observeTorrentCompletion({ ...config,
    fetchImpl: async () => ({ status: 200, text: async () => '{' }) }),
  { state: 'held', reason: 'provider_invalid_response' });
});
