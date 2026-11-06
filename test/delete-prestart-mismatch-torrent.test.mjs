import assert from 'node:assert/strict';
import test from 'node:test';
import { deletePrestartMismatchTorrent } from
  '../src/acquisition/delete-prestart-mismatch-torrent.mjs';

const hash = 'a'.repeat(40);
const savePath = `/downloads/negev/${hash}`;
const attempt = { id: 7, status: 'torrent_observed',
  expectedHash: hash, torrentHash: hash };
const config = { attemptId: 7, baseUrl: 'http://qb.local/',
  sessionId: 'SID123', stagingRoot: '/staging',
  saveRoot: '/downloads/negev', nowMs: 300,
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }) };
const missing = async () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; };
const row = { hash, state: 'stoppedDL', progress: 0, downloaded: 0,
  category: 'negev', save_path: savePath, content_path: `${savePath}/01.mkv`,
  auto_tmm: false, force_start: false };

test('only a stopped zero-byte owned torrent gets one delete without file deletion', async () => {
  const calls = [];
  let reads = 0;
  const ledger = { getAttempt: () => attempt,
    getStalledRetirementIntent: () => ({ hash, status: 'requested' }),
    beginPrestartMismatchDelete: (value) => { calls.push(value);
      return { state: 'delete_unknown', sendNow: true }; } };
  const result = await deletePrestartMismatchTorrent({ ...config, ledger,
    lstatImpl: missing,
    fetchImpl: async (url, init) => {
      if (init.method === 'GET') {
        reads++;
        return new Response(JSON.stringify(url.pathname.endsWith('/info')
          ? [row] : { save_path: savePath, download_path: '' }),
        { status: 200 });
      }
      assert.equal(url.pathname, '/api/v2/torrents/delete');
      assert.equal(init.body.get('hashes'), hash);
      assert.equal(init.body.get('deleteFiles'), 'false');
      return new Response('Ok.', { status: 200 });
    } });
  assert.deepEqual(result, { state: 'delete_unknown', sendNow: true });
  assert.equal(reads, 4);
  assert.deepEqual(calls, [{ attemptId: 7, hash, nowMs: 300 }]);
});

test('downloaded bytes, active state, or existing files prevent deletion', async () => {
  let deletes = 0;
  const ledger = { getAttempt: () => attempt,
    getStalledRetirementIntent: () => ({ hash, status: 'requested' }),
    beginPrestartMismatchDelete: () => { deletes++; throw Error('unsafe'); } };
  const fetchFor = (torrent) => async (url) => new Response(JSON.stringify(
    url.pathname.endsWith('/info') ? [torrent]
      : { save_path: savePath, download_path: '' }), { status: 200 });
  for (const torrent of [{ ...row, downloaded: 1 },
    { ...row, state: 'downloading' }]) {
    assert.deepEqual(await deletePrestartMismatchTorrent({ ...config,
      ledger, lstatImpl: missing, fetchImpl: fetchFor(torrent) }),
    { state: 'held', reason: 'torrent_ownership_changed' });
  }
  const stat = { isDirectory: () => true, isSymbolicLink: () => false,
    dev: 1n, ino: 2n, mtimeNs: 3n };
  assert.deepEqual(await deletePrestartMismatchTorrent({ ...config,
    ledger, lstatImpl: async () => stat,
    readdirImpl: async () => ['partial.mkv'], fetchImpl: fetchFor(row) }),
  { state: 'held', reason: 'staging_not_empty' });
  assert.equal(deletes, 0);
});
