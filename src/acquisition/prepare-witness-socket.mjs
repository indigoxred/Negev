import { lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';

export function probeWitnessSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1_000, () => finish('unknown'));
    socket.once('connect', () => finish('active'));
    socket.once('error', (error) =>
      finish(error?.code === 'ECONNREFUSED' ? 'stale' : 'unknown'));
  });
}

// A power loss can leave the socket pathname behind. Only root's own socket
// in the already-validated private parent may be removed, and only after a
// refused connection and a second same-inode check. Any ambiguity fails shut.
export async function prepareWitnessSocket({ socketPath, clientGid,
  lstatImpl = lstat, unlinkImpl = unlink, probe = probeWitnessSocket } = {}) {
  let before;
  try { before = await lstatImpl(socketPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
  const unsafe = () => { throw new TypeError('Witness socket already exists'); };
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== 0 ||
      ![0, clientGid].includes(before.gid) ||
      (before.mode & 0o777) !== 0o660 ||
      !Number.isSafeInteger(before.dev) || !Number.isSafeInteger(before.ino)) {
    unsafe();
  }
  if (await probe(socketPath) !== 'stale') unsafe();
  let after;
  try { after = await lstatImpl(socketPath); }
  catch { return unsafe(); }
  if (!after.isSocket() || after.isSymbolicLink() || after.uid !== before.uid ||
      after.gid !== before.gid || after.mode !== before.mode ||
      after.dev !== before.dev || after.ino !== before.ino) unsafe();
  await unlinkImpl(socketPath);
  return 'stale_removed';
}
