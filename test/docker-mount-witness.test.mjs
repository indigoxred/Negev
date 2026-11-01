import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMountWitnessHandler, inspectDockerContainer, readMountWitness } from
  '../src/acquisition/docker-mount-witness.mjs';

const names = { qbittorrent: 'downloader', shoko: 'importer',
  plex: 'media-server' };
const inspectResult = (name) => ({ Id: 'a'.repeat(64),
  State: { Running: true }, Config: { Env: ['SECRET=never-export'] },
  Mounts: [{ Type: 'bind', Source: `/srv/${name}`,
    Destination: '/media', RW: true, Name: 'unneeded-private-field' }] });
const rawRequest = (socketPath, method, endpoint) => new Promise((resolve, reject) => {
  const req = request({ socketPath, method, path: endpoint }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject); req.end();
});

test('mount witness exposes only three fixed containers and filtered mounts',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'negev-witness-'));
    const socketPath = path.join(directory, 'mount.sock');
    const calls = [];
    const handler = createMountWitnessHandler({ names,
      inspect: async (name) => { calls.push(name); return inspectResult(name); },
      now: () => 1000, minIntervalMs: 0 });
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await readMountWitness({ socketPath, now: () => 1001 });
      assert.equal(result.state, 'mount_evidence');
      assert.deepEqual(calls, Object.values(names));
      assert.deepEqual(Object.keys(result.mounts), Object.keys(names));
      assert.deepEqual(result.mounts.shoko, [{ Type: 'bind',
        Source: '/srv/importer', Destination: '/media', RW: true }]);
      assert.equal(JSON.stringify(result).includes('SECRET='), false);
      assert.equal(JSON.stringify(result).includes('unneeded-private-field'), false);
      assert.equal(await rawRequest(socketPath, 'POST', '/v1/mounts'), 404);
      assert.equal(await rawRequest(socketPath, 'GET', '/containers/plex/json'), 404);
      assert.equal(await rawRequest(socketPath, 'GET', '/v1/mounts?name=other'), 404);
      assert.deepEqual(calls, [...Object.values(names)]);
      assert.deepEqual(await readMountWitness({ socketPath, now: () => 10_000 }),
        { state: 'held', reason: 'mount_witness_stale' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

test('mount witness rejects stopped, malformed, and oversized Docker data',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'negev-witness-bad-'));
    const socketPath = path.join(directory, 'mount.sock');
    let bad = 'stopped';
    const server = createServer(createMountWitnessHandler({ names,
      inspect: async (name) => bad === 'stopped' && name === 'shoko'
        ? { ...inspectResult(name), State: { Running: false } } :
        bad === 'oversized' && name === 'shoko'
          ? { ...inspectResult(name), Mounts: Array(101).fill(
            inspectResult(name).Mounts[0]) } : inspectResult(name),
      now: () => 1000, minIntervalMs: 0 }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      for (bad of ['stopped', 'oversized']) {
        assert.deepEqual(await readMountWitness({ socketPath, now: () => 1001 }),
          { state: 'held', reason: 'mount_witness_unavailable' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

test('mount witness refuses overlapping requests without extra Docker reads',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'negev-witness-pace-'));
    const socketPath = path.join(directory, 'mount.sock');
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let entered;
    const firstRead = new Promise((resolve) => { entered = resolve; });
    let reads = 0;
    const server = createServer(createMountWitnessHandler({ names,
      inspect: async (name) => {
        reads++;
        if (reads === 1) { entered(); await blocked; }
        return inspectResult(name);
      }, now: () => 1000, minIntervalMs: 0 }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const first = readMountWitness({ socketPath, now: () => 1000 });
      await firstRead;
      assert.deepEqual(await readMountWitness({ socketPath, now: () => 1000 }),
        { state: 'held', reason: 'mount_witness_unavailable' });
      assert.equal(reads, 1);
      release();
      assert.equal((await first).state, 'mount_evidence');
      assert.equal(reads, 3);
    } finally {
      release();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

test('mount witness paces repeated completed requests',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'negev-witness-limit-'));
    const socketPath = path.join(directory, 'mount.sock');
    let reads = 0;
    const server = createServer(createMountWitnessHandler({ names,
      inspect: async (name) => { reads++; return inspectResult(name); },
      now: () => 1000 }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      assert.equal((await readMountWitness({ socketPath,
        now: () => 1000 })).state, 'mount_evidence');
      assert.equal(await rawRequest(socketPath, 'GET', '/v1/mounts'), 429);
      assert.equal(reads, 3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

test('mount witness validates fixed names and never accepts the raw Docker socket', async () => {
  assert.throws(() => createMountWitnessHandler({ names: { ...names,
    plex: '../secrets' }, inspect: async () => null }), TypeError);
  await assert.rejects(readMountWitness({ socketPath: '/var/run/docker.sock' }),
    TypeError);
});

test('Docker read uses one fixed GET and a bounded inspect response',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'negev-fake-docker-'));
    const dockerSocketPath = path.join(directory, 'docker.sock');
    const seen = [];
    let oversized = false;
    const server = createServer((req, res) => {
      seen.push([req.method, req.url]);
      res.setHeader('Content-Type', 'application/json');
      res.end(oversized ? 'x'.repeat(1_000_001) :
        JSON.stringify(inspectResult('plex')));
    });
    await new Promise((resolve) => server.listen(dockerSocketPath, resolve));
    try {
      const item = await inspectDockerContainer('plex', { dockerSocketPath });
      assert.equal(item.Config.Env[0], 'SECRET=never-export');
      assert.deepEqual(seen, [['GET', '/containers/plex/json']]);
      oversized = true;
      await assert.rejects(inspectDockerContainer('plex', { dockerSocketPath }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
