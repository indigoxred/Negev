import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPrivateQbittorrentPassword } from '../src/web/private-shoko-key.mjs';

const run = (dataDir, input) => spawnSync(process.execPath,
  ['src/auth/init-qbittorrent-password.mjs'], {
    cwd: path.resolve('.'), input, encoding: 'utf8',
    env: { ...process.env, NEGEV_DATA_DIR: dataDir },
  });

test('offline qBittorrent setup stores a private password without printing it', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-qbit-setup-'));
  try {
    await mkdir(path.join(dataDir, 'secrets'), { mode: 0o700 });
    const password = ' leading and trailing spaces ';
    const result = run(dataDir, `${password}\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(`${result.stdout}${result.stderr}`.includes(password), false);
    const keyPath = path.join(dataDir, 'secrets', 'qbittorrent.password');
    assert.equal(await readPrivateQbittorrentPassword({ dataDir, keyPath }), password);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    }
    const retry = run(dataDir, 'replacement-password\n');
    assert.notEqual(retry.status, 0);
    assert.equal((await readFile(keyPath, 'utf8')), password);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('offline qBittorrent setup rejects invalid input and loose private dirs', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-qbit-invalid-'));
  try {
    const secretDir = path.join(dataDir, 'secrets');
    await mkdir(secretDir, { mode: 0o700 });
    for (const input of ['', 'two\nlines\n', 'bad\u0000value\n', 'a'.repeat(513)]) {
      const result = run(dataDir, input);
      assert.notEqual(result.status, 0);
      if (input.trim()) {
        assert.equal(`${result.stdout}${result.stderr}`.includes(input.trim()), false);
      }
    }
    await assert.rejects(lstat(path.join(secretDir, 'qbittorrent.password')));
    if (process.platform !== 'win32') {
      await chmod(secretDir, 0o755);
      assert.notEqual(run(dataDir, 'valid-password\n').status, 0);
      await assert.rejects(lstat(path.join(secretDir, 'qbittorrent.password')));
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
