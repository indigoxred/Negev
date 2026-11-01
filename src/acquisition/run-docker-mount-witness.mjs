import { createServer } from 'node:http';
import { chown, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createMountWitnessHandler } from './docker-mount-witness.mjs';

async function main() {
  if (process.platform === 'win32' || process.getuid?.() !== 0) {
    throw new TypeError('Isolated root witness container required');
  }
  const socketPath = process.env.NEGEV_MOUNT_WITNESS_SOCKET;
  const clientGid = Number(process.env.NEGEV_MOUNT_CLIENT_GID);
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') ||
      path.posix.normalize(socketPath) !== socketPath ||
      !socketPath.endsWith('/mount.sock') ||
      !Number.isSafeInteger(clientGid) || clientGid < 1) {
    throw new TypeError('Invalid witness socket configuration');
  }
  const parentPath = path.dirname(socketPath);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      await realpath(parentPath) !== parentPath || parent.uid !== 0 ||
      parent.gid !== clientGid || (parent.mode & 0o777) !== 0o750) {
    throw new TypeError('Private witness socket directory required');
  }
  try {
    await lstat(socketPath);
    throw new TypeError('Witness socket already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const handler = createMountWitnessHandler({ names: {
    qbittorrent: process.env.NEGEV_QBITTORRENT_CONTAINER,
    shoko: process.env.NEGEV_SHOKO_CONTAINER,
    plex: process.env.NEGEV_PLEX_CONTAINER,
  } });
  const server = createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 10;
  process.umask(0o117);
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    listening = true;
    await chown(socketPath, 0, clientGid);
    await chmod(socketPath, 0o660);
  } catch (error) {
    if (listening) {
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
    }
    throw error;
  }
  process.stdout.write('Negev mount witness ready.\n');
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  };
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
}

main().catch((error) => {
  process.stderr.write(`Negev mount witness failed (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
});
