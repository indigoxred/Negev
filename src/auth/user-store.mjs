import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openAccountLedger } from './account-ledger.mjs';

function paths(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      path.normalize(dataDir) !== dataDir || dataDir.includes('\0')) {
    throw new TypeError('Absolute private data directory required');
  }
  return { dbPath: path.join(dataDir, 'negev.sqlite'),
    keyPath: path.join(dataDir, 'session.key') };
}

async function privateDirectory(dataDir, create) {
  if (create) await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new TypeError('Private data directory required');
  }
}

async function readSessionKey(keyPath) {
  const info = await lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32 ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new TypeError('Invalid private session key');
  }
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new TypeError('Invalid private session key');
  return key;
}

async function ensureSessionKey(keyPath) {
  let handle;
  try {
    handle = await open(keyPath, 'wx', 0o600);
    await handle.writeFile(randomBytes(32));
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally { await handle?.close(); }
  return readSessionKey(keyPath);
}

// Offline only: caller supplies the password through private stdin, never an
// environment variable or command-line argument. Existing users are unchanged.
export async function initializeUserStore({ dataDir, username, password } = {}) {
  const { dbPath, keyPath } = paths(dataDir);
  await privateDirectory(dataDir, true);
  const accounts = openAccountLedger(dbPath);
  try {
    const admin = await accounts.bootstrapAdmin({ username, password });
    await ensureSessionKey(keyPath);
    return { state: admin ? 'initialized' : 'already_initialized' };
  } finally { accounts.close(); }
}

export async function openUserStore({ dataDir } = {}) {
  const { dbPath, keyPath } = paths(dataDir);
  await privateDirectory(dataDir, false);
  const sessionKey = await readSessionKey(keyPath);
  const dbInfo = await lstat(dbPath);
  if (!dbInfo.isFile() || dbInfo.isSymbolicLink()) {
    throw new TypeError('Invalid account database');
  }
  const accounts = openAccountLedger(dbPath);
  return { accounts, sessionKey, dbPath };
}
