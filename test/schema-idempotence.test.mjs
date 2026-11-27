import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUserService } from './helpers/scoped-user-service.mjs';

// There is no central schema version: each module creates and patches its own
// tables when it opens. That is only safe while every open is idempotent, so
// a restart (or a rollback and roll-forward) must not change the schema or
// rewrite any row by itself. This opens the whole service twice and compares.
function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((row) => ({ ...row }));
    const rows = {};
    for (const { name } of objects.filter((row) => row.type === 'table')) {
      const digest = createHash('sha256');
      for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) {
        digest.update(JSON.stringify(row));
      }
      rows[name] = digest.digest('hex');
    }
    return { objects, rows };
  } finally { db.close(); }
}

for (const pureMode of [false, true]) {
  test(`reopening the service changes no schema or data (${pureMode ? 'pure' : 'legacy'} mode)`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'negev-idempotent-'));
    const dbPath = path.join(root, 'state.sqlite');
    const open = () => createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.invalid:8111/', shokoApiKey: 'synthetic',
      sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000',
      secureCookies: false, now: () => 1_000,
      acquisition: pureMode ? { pureMode: true } : null,
      fetchImpl: async () => new Response(null, { status: 503 }) });
    try {
      await (await open()).close();
      const first = snapshot(dbPath);
      assert.ok(first.objects.length > 40, 'the service created its ledgers');
      await (await open()).close();
      const second = snapshot(dbPath);
      assert.deepEqual(second.objects, first.objects, 'schema changed on reopen');
      assert.deepEqual(second.rows, first.rows, 'rows changed on reopen');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
