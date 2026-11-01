import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readPrivateQbittorrentPassword } from '../web/private-shoko-key.mjs';

async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new TypeError('Private stdin required');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 514) throw new TypeError('Invalid password input');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    .replace(/\r?\n$/, '');
  if (Buffer.byteLength(value, 'utf8') < 1 ||
      Buffer.byteLength(value, 'utf8') > 512 ||
      /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError('Invalid password input');
  }
  return value;
}

async function privatePaths(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      path.normalize(dataDir) !== dataDir || dataDir.includes('\0')) {
    throw new TypeError('Invalid private data directory');
  }
  const secretDir = path.join(dataDir, 'secrets');
  const keyPath = path.join(secretDir, 'qbittorrent.password');
  const [base, parent] = await Promise.all([lstat(dataDir), lstat(secretDir)]);
  if (!base.isDirectory() || base.isSymbolicLink() ||
      !parent.isDirectory() || parent.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((base.mode | parent.mode) & 0o077) !== 0)) {
    throw new TypeError('Private directory required');
  }
  if (await realpath(secretDir) !== path.join(await realpath(dataDir), 'secrets')) {
    throw new TypeError('Invalid private directory');
  }
  return keyPath;
}

try {
  const dataDir = process.env.NEGEV_DATA_DIR;
  const password = await passwordFromStdin();
  const keyPath = await privatePaths(dataDir);
  let handle;
  let created = false;
  try {
    handle = await open(keyPath, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    await handle.writeFile(password);
    await handle.sync();
  } catch (error) {
    await handle?.close();
    handle = undefined;
    if (created) await unlink(keyPath);
    throw error;
  } finally { await handle?.close(); }
  await readPrivateQbittorrentPassword({ dataDir, keyPath });
  process.stdout.write('Negev qBittorrent password stored privately.\n');
} catch (error) {
  process.stderr.write(`Negev qBittorrent setup failed (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
