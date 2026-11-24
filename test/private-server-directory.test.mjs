import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('rejected diagnostic startup never chmods an existing data directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'negev-private-directory-'));
  try {
    const script = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const stat = fs.lstat;
      fs.lstat = async (...args) => {
        const value = await stat(...args);
        if (args[0] === process.env.NEGEV_DATA_DIR) value.isSymbolicLink = () => true;
        return value;
      };
      fs.chmod = async () => { process.stdout.write('CHMOD_CALLED'); throw Error('directory mutation'); };
      syncBuiltinESMExports();
      await import(${JSON.stringify(new URL('../src/web/private-server.mjs', import.meta.url).href)});
    `;
    let output = '';
    try { output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NEGEV_PRIVATE_TEST: '1', NEGEV_DATA_DIR: directory,
        NEGEV_SHOKO_URL: 'http://shoko.invalid', NEGEV_SHOKO_API_KEY: 'synthetic',
        NEGEV_TEST_TOKEN: 'synthetic-private-token' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }); } catch (error) { output = error.stdout; }
    assert.equal(output.includes('CHMOD_CALLED'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux diagnostic rejection preserves an existing 0750 directory', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'negev-private-mode-'));
  try {
    await chmod(directory, 0o750);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../src/web/private-server.mjs', import.meta.url))], {
      env: { ...process.env, NEGEV_PRIVATE_TEST: '1', NEGEV_DATA_DIR: directory,
        NEGEV_SHOKO_URL: 'http://shoko.invalid', NEGEV_SHOKO_API_KEY: 'synthetic',
        NEGEV_TEST_TOKEN: 'synthetic-private-token' }, stdio: 'pipe', timeout: 5_000,
    }), error => error.status === 1);
    assert.equal((await stat(directory)).mode & 0o777, 0o750);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
