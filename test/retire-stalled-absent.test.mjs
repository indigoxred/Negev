import assert from 'node:assert/strict';
import test from 'node:test';
import { retireStalledAbsent } from '../src/acquisition/retire-stalled-absent.mjs';

const hash = 'a'.repeat(40);
const attempt = { id: 7, status: 'torrent_observed',
  expectedHash: hash, torrentHash: hash };
const config = { attemptId: 7, baseUrl: 'http://qb.local/',
  sessionId: 'SID123', nowMs: 300, stagingRoot: '/staging',
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }) };
const empty = async () => new Response('[]', { status: 200 });
const absent = async () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; };

test('two exact absent reads and an empty owned staging leaf permit retirement', async () => {
    let reads = 0;
    const calls = [];
    const result = await retireStalledAbsent({ ...config,
      lstatImpl: absent,
      ledger: { getAttempt: () => attempt,
        getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
        retireStalled: (input) => { calls.push(input); return { state: 'retired_stalled' }; } },
      fetchImpl: async (url, init) => {
        reads++;
        assert.equal(url.searchParams.get('hashes'), hash);
        assert.equal(init.method, 'GET');
        return empty();
      } });
    assert.deepEqual(result, { state: 'retired_stalled' });
    assert.equal(reads, 2);
    assert.deepEqual(calls, [{ attemptId: 7, hash, nowMs: 300 }]);
});

test('remaining partial data, a present torrent, or provider failure keeps the claim', async () => {
    let retires = 0;
    const ledger = { getAttempt: () => attempt,
      getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
      retireStalled: () => { retires++; throw Error('unsafe retirement'); } };
    const stat = { isDirectory: () => true, isSymbolicLink: () => false,
      dev: 1n, ino: 2n, mtimeNs: 3n };
    assert.deepEqual(await retireStalledAbsent({ ...config,
      ledger, fetchImpl: empty, lstatImpl: async () => stat,
      readdirImpl: async () => ['01.mkv'] }),
      { state: 'held', reason: 'staging_not_empty' });
    assert.deepEqual(await retireStalledAbsent({ ...config,
      ledger, lstatImpl: absent,
      fetchImpl: async () => new Response(JSON.stringify([{ hash }]),
        { status: 200 }) }),
      { state: 'held', reason: 'torrent_still_present' });
    assert.deepEqual(await retireStalledAbsent({ ...config,
      ledger, lstatImpl: absent,
      fetchImpl: async () => new Response('', { status: 403 }) }),
      { state: 'held', reason: 'provider_unavailable' });
    assert.equal(retires, 0);
});

test('retirement needs a durable deletion intent before any provider read', async () => {
  let reads = 0;
  assert.deepEqual(await retireStalledAbsent({ ...config,
    ledger: { getAttempt: () => attempt,
      getStalledRetirementIntent: () => null,
      retireStalled: () => { throw Error('unsafe retirement'); } },
    fetchImpl: async () => { reads++; return empty(); }, lstatImpl: absent }),
  { state: 'held', reason: 'retirement_not_requested' });
  assert.equal(reads, 0);
});
