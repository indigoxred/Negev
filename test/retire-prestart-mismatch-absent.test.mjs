import assert from 'node:assert/strict';
import test from 'node:test';
import { retirePrestartMismatchAbsent } from
  '../src/acquisition/retire-prestart-mismatch-absent.mjs';

const hash = 'a'.repeat(40);
const config = { attemptId: 7, baseUrl: 'http://qb.local/',
  sessionId: 'SID123', stagingRoot: '/staging', nowMs: 300,
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }) };
const attempt = { id: 7, status: 'torrent_observed',
  expectedHash: hash, torrentHash: hash };
const missing = async () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; };

test('two absent torrent reads and empty staging proof release the held claims', async () => {
  const calls = [];
  let reads = 0;
  const result = await retirePrestartMismatchAbsent({ ...config,
    ledger: { getAttempt: () => attempt,
      getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
      retirePrestartMismatch: (value) => { calls.push(value);
        return { state: 'retired_prestart_mismatch' }; } },
    lstatImpl: missing,
    fetchImpl: async (url, init) => {
      reads++;
      assert.equal(url.searchParams.get('hashes'), hash);
      assert.equal(init.method, 'GET');
      return new Response('[]', { status: 200 });
    } });
  assert.deepEqual(result, { state: 'retired_prestart_mismatch' });
  assert.equal(reads, 2);
  assert.deepEqual(calls, [{ attemptId: 7, hash, nowMs: 300 }]);
});

test('a present torrent, partial staging file, or failed read never frees claims', async () => {
  let retired = 0;
  const ledger = { getAttempt: () => attempt,
    getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
    retirePrestartMismatch: () => { retired++; throw Error('unsafe'); } };
  const stat = { isDirectory: () => true, isSymbolicLink: () => false,
    dev: 1n, ino: 2n, mtimeNs: 3n };
  const emptyResponse = async () => new Response('[]', { status: 200 });
  assert.deepEqual(await retirePrestartMismatchAbsent({ ...config, ledger,
    lstatImpl: async () => stat, readdirImpl: async () => ['partial.mkv'],
    fetchImpl: emptyResponse }), { state: 'held', reason: 'staging_not_empty' });
  assert.deepEqual(await retirePrestartMismatchAbsent({ ...config, ledger,
    lstatImpl: missing, fetchImpl: async () => new Response(
      JSON.stringify([{ hash }]), { status: 200 }) }),
  { state: 'held', reason: 'torrent_still_present' });
  assert.deepEqual(await retirePrestartMismatchAbsent({ ...config, ledger,
    lstatImpl: missing, fetchImpl: async () => new Response('', { status: 403 }) }),
  { state: 'held', reason: 'provider_unavailable' });
  assert.equal(retired, 0);
});

test('an absent torrent cannot free claims without a durable delete intent', async () => {
  let reads = 0;
  const result = await retirePrestartMismatchAbsent({ ...config,
    ledger: { getAttempt: () => attempt,
      getStalledRetirementIntent: () => null,
      retirePrestartMismatch: () => { throw Error('unsafe'); } },
    lstatImpl: missing,
    fetchImpl: async () => { reads++; return new Response('[]'); } });
  assert.deepEqual(result, { state: 'held', reason: 'retirement_not_requested' });
  assert.equal(reads, 0);
});
