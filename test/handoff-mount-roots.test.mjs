import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffMountInfo, verifyHandoffMountRoots } from
  '../src/acquisition/handoff-mount-roots.mjs';

const mounts = [
  '24 1 0:1 / / rw - overlay overlay rw',
  '30 24 0:43 /media /mnt/media rw - fuse.shfs shfs rw',
].join('\n');
const roots = { holdingRoot: '/mnt/media/holding',
  importRoot: '/mnt/media/source/Negev' };

test('handoff roots must share one explicit non-overlay mount', () => {
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: mounts, ...roots }),
    { state: 'mounted_handoff_roots' });
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: mounts,
    holdingRoot: '/missing/holding', importRoot: '/missing/import' }),
  { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: mounts,
    ...roots, importRoot: '/other/import' }),
  { state: 'held', reason: 'handoff_mount_unavailable' });
});

test('the reader checks current mountinfo for the resolved roots', async () => {
  const reads = [];
  assert.deepEqual(await verifyHandoffMountRoots({ ...roots,
    resolve: async (value) => value,
    read: async (...args) => { reads.push(args); return mounts; } }),
  { state: 'mounted_handoff_roots' });
  assert.deepEqual(reads, [['/proc/self/mountinfo', 'utf8']]);
});

test('two bind mounts of the same device cannot prove an atomic rename', () => {
  const separate = `${mounts}\n31 24 0:43 /media/source /mnt/media/source rw - fuse.shfs shfs rw`;
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: separate, ...roots }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
});

test('an explicit overlay mount and unavailable mountinfo both hold', async () => {
  const overlay = mounts.replace('fuse.shfs shfs', 'overlay overlay');
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: overlay, ...roots }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(await verifyHandoffMountRoots({ ...roots,
    resolve: async (value) => value,
    read: async () => { throw Error('mountinfo unavailable'); } }),
  { state: 'held', reason: 'handoff_mount_unavailable' });
});

test('a temporary memory mount cannot stand in for the media bind', () => {
  for (const type of ['tmpfs', 'ramfs']) {
    const memory = mounts.replace('fuse.shfs shfs', `${type} ${type}`);
    assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: memory, ...roots }),
      { state: 'held', reason: 'handoff_mount_unavailable' });
  }
});

test('malformed mount evidence cannot authorize a handoff', () => {
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: 'bad', ...roots }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo: mounts,
    holdingRoot: '/mnt/media/../other', importRoot: roots.importRoot }),
  { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(evaluateHandoffMountInfo({ mountInfo:
    `${mounts}\n31 24 0:55 /other /mnt/media rw - fuse.shfs shfs rw`, ...roots }),
  { state: 'held', reason: 'handoff_mount_unavailable' });
});
