import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteStalledTorrent } from '../src/acquisition/delete-stalled-torrent.mjs';

const hash = 'a'.repeat(40);
const attempt = { id: 7, status: 'torrent_observed',
  expectedHash: hash, torrentHash: hash };
const config = { attemptId: 7, baseUrl: 'http://qb.local/',
  sessionId: 'SID123', stagingRoot: '/staging',
  saveRoot: '/Downloads/negev', nowMs: 300,
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
  lstatImpl: async () => ({ isDirectory: () => true,
    isSymbolicLink: () => false }) };
const torrent = { hash, category: 'negev',
  save_path: `/Downloads/negev/${hash}`, auto_tmm: false,
  content_path: `/Downloads/negev/${hash}/01.mkv`,
  force_start: false, progress: 0.2 };
const reply = (value) => new Response(JSON.stringify(value), { status: 200 });

test('records one delete intent before deleting the exact torrent and staged files', async () => {
  let intent = 'requested';
  const order = [];
  const ledger = { getAttempt: () => attempt,
    getStalledRetirementIntent: () => ({ hash, status: intent }),
    beginStalledDelete: () => { intent = 'delete_unknown';
      order.push('intent'); return { state: 'delete_unknown', sendNow: true }; } };
  const result = await deleteStalledTorrent({ ...config, ledger,
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith('/info')) return reply([torrent]);
      if (url.pathname.endsWith('/properties')) return reply({
        save_path: torrent.save_path, download_path: torrent.save_path });
      assert.equal(url.pathname, '/api/v2/torrents/delete');
      assert.equal(init.method, 'POST');
      assert.equal(new URLSearchParams(init.body).get('hashes'), hash);
      assert.equal(new URLSearchParams(init.body).get('deleteFiles'), 'true');
      order.push('delete');
      return new Response('', { status: 200 });
    } });
  assert.deepEqual(result, { state: 'delete_unknown', sendNow: true });
  assert.deepEqual(order, ['intent', 'delete']);
});

test('wrong owner, changed path, or complete torrent cannot reach the delete intent', async () => {
  for (const bad of [
    { ...torrent, category: 'sonarr' },
    { ...torrent, save_path: '/Downloads/other' },
    { ...torrent, content_path: '/Downloads/other/01.mkv' },
    { ...torrent, content_path: `${torrent.save_path}/../other/01.mkv` },
    { ...torrent, content_path: '' },
    { ...torrent, progress: 1 },
  ]) {
    let writes = 0;
    const result = await deleteStalledTorrent({ ...config,
      ledger: { getAttempt: () => attempt,
        getStalledRetirementIntent: () => ({ hash, status: 'requested' }),
        beginStalledDelete: () => { writes++; throw Error('unsafe intent'); } },
      fetchImpl: async (url) => url.pathname.endsWith('/info')
        ? reply([bad]) : reply({ save_path: bad.save_path, download_path: '' }) });
    assert.equal(result.state, 'held');
    assert.equal(writes, 0);
  }
});

test('a saved uncertain delete never sends again after restart', async () => {
  let calls = 0;
  const result = await deleteStalledTorrent({ ...config,
    ledger: { getAttempt: () => attempt,
      getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
      beginStalledDelete: () => ({ state: 'delete_unknown', sendNow: false }) },
    fetchImpl: async () => { calls++; throw Error('unexpected network action'); } });
  assert.deepEqual(result, { state: 'delete_unknown', sendNow: false });
  assert.equal(calls, 0);
});

test('a missing or symlinked staging leaf cannot reach the delete intent', async () => {
  for (const lstatImpl of [
    async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    async () => ({ isDirectory: () => false, isSymbolicLink: () => true }),
  ]) {
    let writes = 0;
    const result = await deleteStalledTorrent({ ...config, lstatImpl,
      ledger: { getAttempt: () => attempt,
        getStalledRetirementIntent: () => ({ hash, status: 'requested' }),
        beginStalledDelete: () => { writes++; throw Error('unsafe intent'); } },
      fetchImpl: async (url) => url.pathname.endsWith('/info')
        ? reply([torrent]) : reply({ save_path: torrent.save_path, download_path: '' }) });
    assert.deepEqual(result, { state: 'held', reason: 'staging_leaf_unverified' });
    assert.equal(writes, 0);
  }
});
