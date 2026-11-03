import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLocalStagingRoot } from '../src/acquisition/local-staging-root.mjs';

const info = '1 0 0:1 / / rw - overlay overlay rw\n' +
  '2 1 0:2 / /staging rw - btrfs /dev/data rw\n' +
  '3 1 0:3 / /import rw - btrfs /dev/pure rw\n' +
  '4 1 0:4 / /holding rw - btrfs /dev/pure rw\n';
const input = { stagingRoot: '/staging', importRoot: '/import/Negev',
  holdingRoot: '/holding',
  resolve: async (value) => value,
  read: async () => info };

test('accepts separate canonical mounted roots without Docker inspection', async () => {
  assert.deepEqual(await verifyLocalStagingRoot(input),
    { state: 'verified_staging_root' });
});

test('holds a missing, redirected, overlapping, or overlay staging root', async () => {
  for (const change of [
    { resolve: async (value) => value === '/staging' ? '/other' : value },
    { resolve: async (value) => { if (value === '/import/Negev') throw Error('missing'); return value; } },
    { importRoot: '/staging/import' },
    { read: async () => '1 0 0:1 / / rw - overlay overlay rw\n' },
    { read: async () => info.replace('/staging rw - btrfs',
      '/staging ro - btrfs') },
  ]) assert.deepEqual(await verifyLocalStagingRoot({ ...input, ...change }),
    { state: 'held', reason: 'staging_root_unverified' });
});
