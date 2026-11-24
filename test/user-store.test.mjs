import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { initializeUserStore, openUserStore } from '../src/auth/user-store.mjs';

test('interrupted first-key writes never publish an empty named key and initialization retries', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-key-interrupt-'));
  try {
    const script = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.open;
      fs.open = async (...args) => {
        const handle = await original(...args);
        if (args[1] === 'wx') handle.writeFile = async () => { throw Error('interrupted write'); };
        return handle;
      };
      syncBuiltinESMExports();
      const { initializeUserStore } = await import(${JSON.stringify(new URL('../src/auth/user-store.mjs', import.meta.url).href)});
      try { await initializeUserStore({ dataDir: process.argv[1], username:'Owner', password:'long-owner-passphrase' }); }
      catch (error) { if (error.message !== 'interrupted write') throw error; }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir]);
    await assert.rejects(readFile(path.join(dataDir, 'session.key')), { code: 'ENOENT' });
    await initializeUserStore({ dataDir, username: 'Owner', password: 'long-owner-passphrase' });
    assert.equal((await readFile(path.join(dataDir, 'session.key'))).length, 32);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('offline initialization creates one admin and a private persistent session key', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-user-store-'));
  try {
    const first = await initializeUserStore({ dataDir, username: 'Owner',
      password: 'a-long-test-passphrase' });
    assert.equal(first.state, 'initialized');
    const keyPath = path.join(dataDir, 'session.key');
    const key = await readFile(keyPath);
    assert.equal(key.length, 32);
    if (process.platform !== 'win32') {
      assert.equal((await stat(keyPath)).mode & 0o077, 0);
    }
    const second = await initializeUserStore({ dataDir, username: 'Different',
      password: 'another-long-passphrase' });
    assert.equal(second.state, 'already_initialized');
    assert.deepEqual(await readFile(keyPath), key);
    const opened = await openUserStore({ dataDir });
    assert.deepEqual(opened.sessionKey, key);
    opened.accounts.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('invalid session-key length fails server startup without changing it', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-user-store-'));
  try {
    await initializeUserStore({ dataDir, username: 'Owner',
      password: 'a-long-test-passphrase' });
    await writeFile(path.join(dataDir, 'session.key'), Buffer.alloc(16));
    await assert.rejects(openUserStore({ dataDir }), TypeError);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('concurrent initializers publish one complete persistent key', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-key-race-'));
  try {
    await Promise.all(Array.from({ length: 5 }, () => initializeUserStore({ dataDir,
      username: 'Owner', password: 'long-owner-passphrase' })));
    const key = await readFile(path.join(dataDir, 'session.key'));
    assert.equal(key.length, 32);
    const store = await openUserStore({ dataDir });
    assert.deepEqual(store.sessionKey, key);
    store.accounts.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
