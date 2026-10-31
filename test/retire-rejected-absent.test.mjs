import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUnderTest = await import('../src/acquisition/retire-rejected-absent.mjs')
  .catch(() => ({}));
const hash = 'a'.repeat(40);
const attempt = { id: 7, status: 'rejected_held', torrentHash: hash,
  expectedHash: hash, rejectionReason: 'file_wrong_identity' };
const config = { attemptId: 7, baseUrl: 'http://qbittorrent.internal:8080/',
  sessionId: 'syntheticSID', nowMs: 300 };

test('two exact authenticated empty torrent reads retire one rejected claim', async () => {
  assert.equal(typeof moduleUnderTest.retireRejectedAbsent, 'function');
  const calls = [];
  const ledger = { getAttempt: () => attempt,
    retireRejected: (input) => { calls.push(input); return { state: 'retired_rejected' }; } };
  const requests = [];
  const result = await moduleUnderTest.retireRejectedAbsent({ ...config, ledger,
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), init });
      return Response.json([]);
    } });
  assert.deepEqual(result, { state: 'retired_rejected' });
  assert.deepEqual(calls, [{ attemptId: 7, hash, nowMs: 300 }]);
  assert.equal(requests.length, 2);
  assert.equal(requests.every(({ url, init }) =>
    url.pathname === '/api/v2/torrents/info' &&
    url.searchParams.get('hashes') === hash &&
    init.method === 'GET' && init.redirect === 'manual' &&
    init.headers.Cookie === 'SID=syntheticSID'), true);
});

test('present torrent, failed authentication, or changed response retains the claim', async () => {
  assert.equal(typeof moduleUnderTest.retireRejectedAbsent, 'function');
  for (const replies of [
    [Response.json([{ hash }])],
    [Response.json([]), Response.json([{ hash }])],
    [new Response('', { status: 403 })],
    [Response.json([]), new Response('', { status: 503 })],
    [Response.json({})],
  ]) {
    let reads = 0;
    let retires = 0;
    const result = await moduleUnderTest.retireRejectedAbsent({ ...config,
      ledger: { getAttempt: () => attempt,
        retireRejected: () => { retires++; throw Error('unexpected retirement'); } },
      fetchImpl: async () => replies[reads++] });
    assert.equal(result.state, 'held');
    assert.equal(retires, 0);
  }
});

test('a nonrejected attempt cannot query qBittorrent or retire', async () => {
  assert.equal(typeof moduleUnderTest.retireRejectedAbsent, 'function');
  let calls = 0;
  const result = await moduleUnderTest.retireRejectedAbsent({ ...config,
    ledger: { getAttempt: () => ({ ...attempt, status: 'torrent_observed' }),
      retireRejected: () => { calls++; throw Error('unexpected retirement'); } },
    fetchImpl: async () => { calls++; throw Error('unexpected qBittorrent read'); } });
  assert.deepEqual(result, { state: 'held', reason: 'candidate_not_rejected' });
  assert.equal(calls, 0);
});

test('a previously retired attempt remains an idempotent result without a new read', async () => {
  let calls = 0;
  const result = await moduleUnderTest.retireRejectedAbsent({ ...config,
    ledger: { getAttempt: () => ({ ...attempt, status: 'retired_rejected' }),
      retireRejected: () => { calls++; throw Error('unexpected retirement'); } },
    fetchImpl: async () => { calls++; throw Error('unexpected qBittorrent read'); } });
  assert.deepEqual(result, { state: 'retired_rejected' });
  assert.equal(calls, 0);
});
