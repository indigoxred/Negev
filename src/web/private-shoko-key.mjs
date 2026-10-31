import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

// Keep service credentials out of Docker inspect and logs. Only fixed
// filenames under the private data directory are accepted.
async function readPrivateKey({ dataDir, keyPath, filename, password = false } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      typeof keyPath !== 'string' ||
      keyPath !== path.join(dataDir, 'secrets', filename)) {
    throw new TypeError('Invalid private key path');
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
    throw new TypeError('Invalid private key file');
  }
  const [realBase, realParent, realFile] = await Promise.all([
    realpath(dataDir), realpath(secretDir), realpath(keyPath),
  ]);
  if (realParent !== path.join(realBase, 'secrets') ||
      realFile !== path.join(realParent, filename)) {
    throw new TypeError('Invalid private key location');
  }
  const handle = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.dev !== file.dev ||
        current.ino !== file.ino || current.size !== file.size) {
      throw new TypeError('Private key file changed');
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    const key = password ? raw.replace(/\r?\n$/, '') : raw.trim();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== current.dev || after.ino !== current.ino ||
        after.size !== current.size || after.mtimeNs !== current.mtimeNs) {
      throw new TypeError('Private key file changed');
    }
    if (key.length < 1 || key.length > 512 ||
        (password ? /[\x00-\x1f\x7f]/.test(key) : /[\s\x00-\x1f]/.test(key))) {
      throw new TypeError('Invalid private key');
    }
    return key;
  } finally { await handle.close(); }
}

export const readPrivateShokoKey = ({ dataDir, keyPath } = {}) =>
  readPrivateKey({ dataDir, keyPath, filename: 'shoko.token' });

export const readPrivatePlexToken = ({ dataDir, keyPath } = {}) =>
  readPrivateKey({ dataDir, keyPath, filename: 'plex.token' });

export const readPrivateProwlarrKey = ({ dataDir, keyPath } = {}) =>
  readPrivateKey({ dataDir, keyPath, filename: 'prowlarr.token' });

export const readPrivateQbittorrentPassword = ({ dataDir, keyPath } = {}) =>
  readPrivateKey({ dataDir, keyPath, filename: 'qbittorrent.password', password: true });
