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
    lstat(dataDir, { bigint: true }), lstat(secretDir, { bigint: true }),
    lstat(keyPath, { bigint: true }),
  ]);
  if (!base.isDirectory() || base.isSymbolicLink() ||
      !parent.isDirectory() || parent.isSymbolicLink() ||
      !file.isFile() || file.isSymbolicLink() || file.size < 1n || file.size > 512n ||
      (process.platform !== 'win32' &&
        ((base.mode | parent.mode | file.mode) & 0o077n) !== 0n)) {
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
    if (!current.isFile() || current.dev !== file.dev ||
        current.ino !== file.ino || current.size !== file.size) {
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
