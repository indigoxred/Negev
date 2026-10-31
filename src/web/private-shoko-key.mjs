import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

// Keep the account server's Shoko credential out of Docker inspect and logs.
export async function readPrivateShokoKey({ dataDir, keyPath } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      typeof keyPath !== 'string' ||
      keyPath !== path.join(dataDir, 'secrets', 'shoko.token')) {
    throw new TypeError('Invalid Shoko key path');
  }
  const secretDir = path.dirname(keyPath);
  const [base, parent, file] = await Promise.all([
    lstat(dataDir), lstat(secretDir), lstat(keyPath),
  ]);
  if (!base.isDirectory() || base.isSymbolicLink() ||
      !parent.isDirectory() || parent.isSymbolicLink() ||
      !file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 512 ||
      (process.platform !== 'win32' &&
        ((base.mode | parent.mode | file.mode) & 0o077) !== 0)) {
    throw new TypeError('Invalid private Shoko key file');
  }
  const [realBase, realParent, realFile] = await Promise.all([
    realpath(dataDir), realpath(secretDir), realpath(keyPath),
  ]);
  if (realParent !== path.join(realBase, 'secrets') ||
      realFile !== path.join(realParent, 'shoko.token')) {
    throw new TypeError('Invalid private Shoko key location');
  }
  const handle = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.dev !== BigInt(file.dev) ||
        current.ino !== BigInt(file.ino) || current.size !== BigInt(file.size)) {
      throw new TypeError('Shoko key file changed');
    }
    const key = (await handle.readFile({ encoding: 'utf8' })).trim();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== current.dev || after.ino !== current.ino ||
        after.size !== current.size || after.mtimeNs !== current.mtimeNs) {
      throw new TypeError('Shoko key file changed');
    }
    if (key.length < 1 || key.length > 512 || /[\s\x00-\x1f]/.test(key)) {
      throw new TypeError('Invalid private Shoko key');
    }
    return key;
  } finally { await handle.close(); }
}
