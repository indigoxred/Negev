import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('admin bootstrap reads a private stdin password and prints no secret', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-admin-cli-'));
  try {
    const run = spawnSync(process.execPath, ['src/auth/init-admin.mjs'], {
      cwd: path.resolve('.'), input: 'a-long-test-passphrase\n', encoding: 'utf8',
      env: { ...process.env, NEGEV_DATA_DIR: dataDir,
        NEGEV_ADMIN_USERNAME: 'Owner' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(`${run.stdout}${run.stderr}`.includes('a-long-test-passphrase'), false);
    assert.equal((await readFile(path.join(dataDir, 'session.key'))).length, 32);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
