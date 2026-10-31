import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPrivatePlexToken, readPrivateProwlarrKey,
  readPrivateShokoKey } from '../src/web/private-shoko-key.mjs';

test('account server reads a restricted Shoko token file without using Docker env secrets', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-key-'));
  try {
    const secretDir = path.join(dataDir, 'secrets');
    await mkdir(secretDir, { mode: 0o700 });
    const keyPath = path.join(secretDir, 'shoko.token');
    await writeFile(keyPath, 'synthetic-key\n', { mode: 0o600 });
    assert.equal(await readPrivateShokoKey({ dataDir, keyPath }), 'synthetic-key');
    await writeFile(keyPath, '');
    await assert.rejects(readPrivateShokoKey({ dataDir, keyPath }), TypeError);
    await writeFile(keyPath, 'x'.repeat(513));
    await assert.rejects(readPrivateShokoKey({ dataDir, keyPath }), TypeError);
    if (process.platform !== 'win32') {
      await writeFile(keyPath, 'synthetic-key');
      await chmod(keyPath, 0o644);
      await assert.rejects(readPrivateShokoKey({ dataDir, keyPath }), TypeError);
      await rm(keyPath);
      await symlink(path.join(dataDir, 'session.key'), keyPath);
      await assert.rejects(readPrivateShokoKey({ dataDir, keyPath }), TypeError);
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('Prowlarr discovery reads only its own restricted token file', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-prowlarr-key-'));
  try {
    const secretDir = path.join(dataDir, 'secrets');
    await mkdir(secretDir, { mode: 0o700 });
    const keyPath = path.join(secretDir, 'prowlarr.token');
    await writeFile(keyPath, 'synthetic-prowlarr\n', { mode: 0o600 });
    assert.equal(await readPrivateProwlarrKey({ dataDir, keyPath }),
      'synthetic-prowlarr');
    await assert.rejects(readPrivateProwlarrKey({ dataDir,
      keyPath: path.join(secretDir, 'plex.token') }), TypeError);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('private Plex token uses its own restricted file and never a Shoko path', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'negev-plex-key-'));
  try {
    const secretDir = path.join(dataDir, 'secrets');
    await mkdir(secretDir, { mode: 0o700 });
    const keyPath = path.join(secretDir, 'plex.token');
    await writeFile(keyPath, 'synthetic-plex\n', { mode: 0o600 });
    assert.equal(await readPrivatePlexToken({ dataDir, keyPath }), 'synthetic-plex');
    await assert.rejects(readPrivatePlexToken({ dataDir,
      keyPath: path.join(secretDir, 'shoko.token') }), TypeError);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
