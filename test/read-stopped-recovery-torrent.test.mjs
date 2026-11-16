import assert from 'node:assert/strict';
import test from 'node:test';
import { readStoppedRecoveryTorrent } from
  '../src/acquisition/read-stopped-recovery-torrent.mjs';

test('recovery requires the exact stopped owned torrent', async () => {
  const hash = 'a'.repeat(40);
  const torrent = { hash, category: 'negev',
    save_path: `/Downloads/negev/${hash}`, state: 'stoppedUP',
    progress: 1, force_start: false, auto_tmm: false };
  const run = (item) => readStoppedRecoveryTorrent({
    baseUrl: 'http://qb:8080/', sessionId: 'session', hash,
    saveRoot: '/Downloads/negev',
    fetchImpl: async () => Response.json([item]),
  });
  assert.equal((await run(torrent)).state, 'stopped');
  assert.equal((await run({ ...torrent, state: 'downloading' })).state,
    'active');
  assert.equal((await run({ ...torrent, category: 'other' })).state,
    'unavailable');
});
