import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLocalStagingRoot } from '../src/acquisition/local-staging-root.mjs';

const info = '1 0 0:1 / / rw - overlay overlay rw\n' +
  '2 1 0:2 / /staging ro - btrfs /dev/data rw\n' +
  '3 1 0:3 / /import rw - btrfs /dev/pure rw\n' +
  '4 1 0:4 / /holding rw - btrfs /dev/pure rw\n';
const input = { stagingRoot: '/staging', importRoot: '/import/Negev',
  holdingRoot: '/holding',
  resolve: async (value) => value,
  read: async () => info,
  openDir: async () => ({ close: async () => {} }) };

test('accepts separate canonical read-only staging without Docker inspection', async () => {
  assert.deepEqual(await verifyLocalStagingRoot(input),
    { state: 'verified_staging_root' });
});

test('pure move needs one writable bind for staging, holding and Import', async () => {
  const oneMount = '1 0 0:1 / / rw - overlay overlay rw\n' +
    '2 1 0:2 / /handoff rw - btrfs /dev/pure rw\n';
  const pure = { ...input, stagingRoot: '/handoff/staging',
    holdingRoot: '/handoff/holding', importRoot: '/handoff/source/Negev',
    writablePureMove: true, read: async () => oneMount };
  assert.deepEqual(await verifyLocalStagingRoot(pure),
    { state: 'verified_staging_root' });
  assert.deepEqual(await verifyLocalStagingRoot({ ...pure,
    read: async () => oneMount +
      '3 2 0:3 / /handoff/staging rw - btrfs /dev/pure rw\n' }),
  { state: 'held', reason: 'staging_root_unverified' });
});

test('holds a missing, redirected, overlapping, or overlay staging root', async () => {
  for (const change of [
    { resolve: async (value) => value === '/staging' ? '/other' : value },
    { resolve: async (value) => { if (value === '/import/Negev') throw Error('missing'); return value; } },
    { importRoot: '/staging/import' },
    { read: async () => '1 0 0:1 / / rw - overlay overlay rw\n' },
    { read: async () => info.replace('/staging ro - btrfs',
      '/staging rw - btrfs') },
    { openDir: async () => { const error = new Error('permission denied');
      error.code = 'EACCES'; throw error; } },
  ]) assert.deepEqual(await verifyLocalStagingRoot({ ...input, ...change }),
    { state: 'held', reason: 'staging_root_unverified' });
});
