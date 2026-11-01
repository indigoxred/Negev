import { request } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const roles = ['qbittorrent', 'shoko', 'plex'];
const held = (reason) => ({ state: 'held', reason });
const safeName = (value) => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
const absolute = (value) => typeof value === 'string' &&
  value.startsWith('/') && !value.includes('\\') &&
  !value.includes('\0') && path.posix.normalize(value) === value;
const validMount = (mount) => mount && typeof mount === 'object' &&
  absolute(mount.Source) && absolute(mount.Destination) &&
  typeof mount.Type === 'string' && mount.Type.length > 0 &&
  typeof mount.RW === 'boolean';

async function requestJson({ socketPath, endpoint, maximumBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: endpoint, method: 'GET',
      headers: { Accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200 ||
          Number(response.headers['content-length']) > maximumBytes) {
        response.resume(); reject(new TypeError('Mount witness unavailable'));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maximumBytes) {
          response.destroy(new TypeError('Mount witness oversized'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new TypeError('Mount witness timed out')));
    req.on('error', reject);
    req.end();
  });
}

// This function belongs only in the isolated witness process. It reads a
// fixed Docker inspect endpoint and never forwards the raw inspect JSON.
export async function inspectDockerContainer(name, {
  dockerSocketPath = '/var/run/docker.sock', timeoutMs = 5_000,
} = {}) {
  if (!safeName(name) || !absolute(dockerSocketPath) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('Invalid Docker inspect configuration');
  }
  return requestJson({ socketPath: dockerSocketPath,
    endpoint: `/containers/${encodeURIComponent(name)}/json`,
    maximumBytes: 1_000_000, timeoutMs });
}

// The caller-facing service can request one filtered snapshot only. No name,
// Docker API path, method, environment, labels, or HostConfig reaches it.
export function createMountWitnessHandler({ names,
  inspect = inspectDockerContainer, now = Date.now,
  minIntervalMs = 2_000 } = {}) {
  if (!names || typeof names !== 'object' || Array.isArray(names) ||
      Object.keys(names).sort().join(',') !== [...roles].sort().join(',') ||
      roles.some((role) => !safeName(names[role])) ||
      new Set(Object.values(names)).size !== roles.length ||
      typeof inspect !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 ||
      minIntervalMs > 60_000) {
    throw new TypeError('Invalid mount witness configuration');
  }
  let busy = false;
  let lastStartedAtMs = null;
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || req.url !== '/v1/mounts' ||
        req.headers['content-length'] !== undefined ||
        req.headers['transfer-encoding'] !== undefined) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    let startedAtMs;
    let acquired = false;
    try {
      startedAtMs = now();
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
        throw new TypeError('Invalid mount clock');
      }
      if (busy || (lastStartedAtMs !== null &&
          startedAtMs - lastStartedAtMs < minIntervalMs)) {
        res.statusCode = 429;
        res.end('{}');
        return;
      }
      busy = true;
      acquired = true;
      lastStartedAtMs = startedAtMs;
      const mounts = {};
      const containers = {};
      for (const role of roles) {
        const item = await inspect(names[role]);
        if (!/^[0-9a-f]{64}$/i.test(item?.Id) ||
            item?.State?.Running !== true ||
            !Array.isArray(item.Mounts) || item.Mounts.length > 100 ||
            item.Mounts.some((mount) => !validMount(mount))) {
          throw new TypeError('Invalid Docker mount evidence');
        }
        containers[role] = item.Id;
        mounts[role] = item.Mounts.map((mount) => ({
          Type: mount.Type, Source: mount.Source,
          Destination: mount.Destination, RW: mount.RW,
        }));
      }
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new TypeError('Invalid mount clock');
      }
      res.end(JSON.stringify({ state: 'mount_evidence',
        observedAtMs, containers, mounts }));
    } catch {
      res.statusCode = 503;
      res.end('{}');
    } finally {
      if (acquired) busy = false;
    }
  };
}

// Used by the account-facing service. The raw Docker socket is explicitly
// forbidden here, even if an operator misconfigures the witness path.
export async function readMountWitness({ socketPath, now = Date.now,
  timeoutMs = 15_000 } = {}) {
  if (!absolute(socketPath) || path.posix.basename(socketPath) === 'docker.sock' ||
      typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 15_000) {
    throw new TypeError('Invalid mount witness client configuration');
  }
  let item;
  try {
    const socket = await lstat(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() ||
        await realpath(socketPath) !== socketPath) {
      return held('mount_witness_unavailable');
    }
    item = await requestJson({ socketPath, endpoint: '/v1/mounts',
      maximumBytes: 50_000, timeoutMs });
  }
  catch { return held('mount_witness_unavailable'); }
  const checkedAtMs = now();
  if (item?.state !== 'mount_evidence' ||
      !Number.isSafeInteger(item.observedAtMs) ||
      !Number.isSafeInteger(checkedAtMs) ||
      item.observedAtMs < 0 || checkedAtMs < item.observedAtMs ||
      checkedAtMs - item.observedAtMs > 5_000) {
    return held('mount_witness_stale');
  }
  if (!item.mounts || !item.containers ||
      Object.keys(item.mounts).sort().join(',') !== [...roles].sort().join(',') ||
      Object.keys(item.containers).sort().join(',') !== [...roles].sort().join(',') ||
      roles.some((role) => !/^[0-9a-f]{64}$/i.test(item.containers[role]) ||
        !Array.isArray(item.mounts[role]) || item.mounts[role].length > 100 ||
        item.mounts[role].some((mount) => !validMount(mount) ||
          Object.keys(mount).sort().join(',') !== 'Destination,RW,Source,Type'))) {
    return held('mount_witness_unavailable');
  }
  return { state: 'mount_evidence', mounts: item.mounts,
    observedAtMs: item.observedAtMs };
}
