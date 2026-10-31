import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeUserStore } from '../src/auth/user-store.mjs';

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

test('offline-initialized account service starts locally without an acquisition worker', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-user-server-'));
  let child;
  try {
    await initializeUserStore({ dataDir, username: 'Owner',
      password: 'a-long-test-passphrase' });
    const port = await availablePort();
    child = spawn(process.execPath, ['src/web/user-server.mjs'], {
      cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NEGEV_USER_SERVER: '1', NEGEV_DATA_DIR: dataDir,
        NEGEV_SHOKO_URL: 'http://shoko.invalid:8111',
        NEGEV_SHOKO_API_KEY: 'synthetic-key',
        NEGEV_PUBLIC_ORIGIN: `http://localhost:${port}`,
        NEGEV_PORT: String(port) },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    const url = `http://127.0.0.1:${port}/health/live`;
    let healthy = false;
    let lastError;
    for (let i = 0; i < 120 && !healthy; i++) {
      if (child.exitCode !== null) break;
      try { healthy = (await fetch(url)).status === 200; }
      catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
      if (lastError?.cause?.code === 'EACCES' &&
          stdout.includes('Negev user API listening')) break;
    }
    if (!healthy && lastError?.cause?.code === 'EACCES' &&
        stdout.includes('Negev user API listening')) {
      t.skip('Windows sandbox denies cross-process loopback connections');
      return;
    }
    assert.equal(healthy, true,
      `account-backed listener did not start: ${stderr} ${stdout} ${child.exitCode} ${lastError?.cause ?? lastError}`);
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/catalogue/search?q=anime`);
    assert.equal(anonymous.status, 401);
  } finally {
    child?.kill();
    if (child && child.exitCode === null) await once(child, 'exit');
    await rm(dataDir, { recursive: true, force: true });
  }
});
