import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { recoverOrphanedHolding } from '../src/acquisition/orphaned-holding-recovery.mjs';

test('restart removes only unjournaled private preparation directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-holding-recovery-'));
  try {
    const holdingRoot = path.join(root, 'holding');
    await mkdir(holdingRoot);
    const orphan = path.join(holdingRoot, '.negev-prep-ABC123');
    const recorded = path.join(holdingRoot, '.negev-prep-DEF456');
    const unrelated = path.join(holdingRoot, 'other');
    for (const folder of [orphan, recorded, unrelated]) {
      await mkdir(folder);
      await writeFile(path.join(folder, 'file'), 'private');
    }
    const dbPath = path.join(root, 'negev.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE handoff_intents (holding_path TEXT NOT NULL)');
    db.prepare('INSERT INTO handoff_intents VALUES (?)').run(recorded);
    db.close();
    assert.deepEqual(await recoverOrphanedHolding({ holdingRoot, dbPath }),
      { removed: 1 });
    assert.deepEqual((await readdir(holdingRoot)).sort(),
      ['.negev-prep-DEF456', 'other']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
