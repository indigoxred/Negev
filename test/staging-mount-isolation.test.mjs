import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateStagingMountIsolation } from '../src/acquisition/staging-mount-isolation.mjs';

const staging = '/srv/negev/staging';
const bind = { Type: 'bind', Source: staging, Destination: '/negev-staging', RW: true };
const mounts = {
  qbittorrent: [bind, { Type: 'bind', Source: '/srv/library/import', Destination: '/Shoko', RW: true }],
  shoko: [{ Type: 'bind', Source: '/srv/library', Destination: '/pure', RW: true }],
  plex: [{ Type: 'bind', Source: '/srv/library', Destination: '/source-pure', RW: false }],
};
const check = (evidence) => evaluateStagingMountIsolation(evidence, { hostPath: staging });

test('accepts a narrow writable qBittorrent bind outside Shoko and Plex mounts', () => {
  assert.deepEqual(check(mounts),
    { state: 'isolated_mount', hostPath: staging, containerPath: '/negev-staging' });
});

test('holds missing, broad, duplicate, or wrong qBittorrent staging mounts', () => {
  const withQbit = (qbittorrent) => check({ ...mounts, qbittorrent });
  assert.deepEqual(withQbit([]), { state: 'held', reason: 'staging_bind_missing' });
  assert.deepEqual(withQbit([{ ...bind, Source: '/srv/negev' }]),
    { state: 'held', reason: 'staging_bind_mismatch' });
  assert.deepEqual(withQbit([{ ...bind, RW: false }]),
    { state: 'held', reason: 'staging_bind_mismatch' });
  assert.deepEqual(withQbit([bind, bind]),
    { state: 'held', reason: 'staging_bind_mismatch' });
  assert.deepEqual(withQbit([{ ...bind, Type: 'volume' }]),
    { state: 'held', reason: 'staging_bind_mismatch' });
});

test('holds any Shoko or Plex mount covering staging or inside staging', () => {
  const exposure = (source) => [{ Type: 'bind', Source: source, Destination: '/visible', RW: false }];
  for (const source of ['/srv', '/srv/negev', staging, `${staging}/part`]) {
    assert.deepEqual(check({ ...mounts, shoko: exposure(source) }),
      { state: 'held', reason: 'staging_visible_to_shoko' });
    assert.deepEqual(check({ ...mounts, plex: exposure(source) }),
      { state: 'held', reason: 'staging_visible_to_plex' });
  }
  assert.equal(check({ ...mounts,
    shoko: exposure('/srv/negev/staging-other') }).state, 'isolated_mount');
});

test('holds absent or malformed consumer mount evidence', () => {
  assert.deepEqual(check({ ...mounts, plex: undefined }),
    { state: 'held', reason: 'invalid_mount_evidence' });
  assert.deepEqual(check({ ...mounts,
    plex: [{ Source: '/srv/../data', Destination: '/other', Type: 'bind' }] }),
    { state: 'held', reason: 'invalid_mount_evidence' });
});
