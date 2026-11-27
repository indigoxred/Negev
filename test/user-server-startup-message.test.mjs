import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/web/user-server.mjs', import.meta.url));
const dataDir = path.resolve('private-negev-startup-test');

function start(env) {
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test('a failed start prints the reason, not just the error type', () => {
  const { status, stderr } = start({ NEGEV_USER_SERVER: '1', NEGEV_DATA_DIR: dataDir,
    NEGEV_SHOKO_URL: 'http://shoko.internal:8111',
    NEGEV_SHOKO_API_KEY_FILE: path.join(dataDir, 'secrets', 'shoko.token'),
    NEGEV_PUBLIC_ORIGIN: 'http://localhost:3000', NEGEV_LOG_LEVEL: 'loud' });
  assert.equal(status, 1);
  assert.match(stderr,
    /^Negev user API failed to start \(TypeError\): NEGEV_LOG_LEVEL must be silent, error, warn, info or debug\.\n$/);
});

test('the stack trace is printed only with NEGEV_DEBUG_STARTUP=1', () => {
  const env = { NEGEV_USER_SERVER: '1', NEGEV_DATA_DIR: dataDir,
    NEGEV_SHOKO_URL: 'http://shoko.internal:8111',
    NEGEV_SHOKO_API_KEY_FILE: path.join(dataDir, 'secrets', 'shoko.token'),
    NEGEV_PUBLIC_ORIGIN: 'http://localhost:3000', NEGEV_LOG_LEVEL: 'loud' };
  assert.doesNotMatch(start(env).stderr, /user-server-config\.mjs/);
  assert.match(start({ ...env, NEGEV_DEBUG_STARTUP: '1' }).stderr, /user-server-config\.mjs/);
});
