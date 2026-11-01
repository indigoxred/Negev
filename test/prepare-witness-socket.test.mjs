import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareWitnessSocket, probeWitnessSocket } from
  '../src/acquisition/prepare-witness-socket.mjs';

const socket = (overrides = {}) => ({
  isSocket: () => true, isSymbolicLink: () => false,
  uid: 0, gid: 100, mode: 0o140660, dev: 1, ino: 2,
  ...overrides,
});

test('verified stale witness socket is removed before bind', async () => {
  const removed = [];
  const result = await prepareWitnessSocket({ socketPath: '/data/mount.sock',
    clientGid: 100, lstatImpl: async () => socket(),
    probe: async () => 'stale', unlinkImpl: async (name) => removed.push(name) });
  assert.equal(result, 'stale_removed');
  assert.deepEqual(removed, ['/data/mount.sock']);
});

test('live or uncertain witness socket is never removed', async () => {
  for (const state of ['active', 'unknown']) {
    await assert.rejects(prepareWitnessSocket({ socketPath: '/data/mount.sock',
      clientGid: 100, lstatImpl: async () => socket(),
      probe: async () => state,
      unlinkImpl: async () => { throw Error('removed active socket'); } }),
    /Witness socket already exists/);
  }
});

test('changed, foreign, and symlink sockets are never removed', async () => {
  for (const bad of [socket({ uid: 1 }), socket({ gid: 9 }),
    socket({ isSymbolicLink: () => true }), socket({ isSocket: () => false })]) {
    await assert.rejects(prepareWitnessSocket({ socketPath: '/data/mount.sock',
      clientGid: 100, lstatImpl: async () => bad,
      probe: async () => 'stale',
      unlinkImpl: async () => { throw Error('removed unsafe socket'); } }),
    /Witness socket already exists/);
  }
  let reads = 0;
  await assert.rejects(prepareWitnessSocket({ socketPath: '/data/mount.sock',
    clientGid: 100, lstatImpl: async () => socket({ ino: ++reads }),
    probe: async () => 'stale',
    unlinkImpl: async () => { throw Error('removed replaced socket'); } }),
  /Witness socket already exists/);
});

test('missing witness socket needs no cleanup', async () => {
  assert.equal(await prepareWitnessSocket({ socketPath: '/data/mount.sock',
    clientGid: 100, lstatImpl: async () => { const e = Error(); e.code = 'ENOENT'; throw e; },
    probe: async () => { throw Error('probed missing socket'); },
    unlinkImpl: async () => { throw Error('removed missing socket'); } }), 'absent');
});

test('a killed Linux listener leaves a socket that probes stale',
  { skip: process.platform !== 'linux' }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-witness-'));
    const socketPath = path.join(dir, 'mount.sock');
    const code = `require('node:net').createServer().listen(${JSON.stringify(socketPath)},` +
      `()=>process.stdout.write('ready\\n'))`;
    const child = spawn(process.execPath, ['-e', code],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [ready] = await once(child.stdout, 'data',
        { signal: AbortSignal.timeout(5_000) });
      assert.match(ready.toString(), /ready/);
      assert.equal(await probeWitnessSocket(socketPath), 'active');
      child.kill('SIGKILL');
      await once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
      assert.equal(await probeWitnessSocket(socketPath), 'stale');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });
