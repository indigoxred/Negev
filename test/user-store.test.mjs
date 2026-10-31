import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeUserStore, openUserStore } from '../src/auth/user-store.mjs';

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
