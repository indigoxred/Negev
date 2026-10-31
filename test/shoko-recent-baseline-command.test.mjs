import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { runShokoRecentBaseline } from
  '../src/availability/shoko-recent-baseline-command.mjs';

test('explicit baseline command reads only two bounded heads and journals their IDs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-command-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const reads = [];
  const pauses = [];
  try {
    const result = await runShokoRecentBaseline({ dbPath,
      shokoBaseUrl: 'http://shoko.invalid:8111', apiKey: 'synthetic-key',
      pause: async (ms) => { pauses.push(ms); },
      fetchImpl: async (url, init) => {
        reads.push({ url: String(url), method: init.method,
          redirect: init.redirect });
        return new Response(JSON.stringify({ Total: 2, List: [
          { ID: 12, Imported: '2026-11-01T00:00:12Z' },
          { ID: 11, Imported: '2026-11-01T00:00:11Z' },
        ] }), { headers: { 'content-type': 'application/json' } });
      } });
    assert.equal(result.state, 'baseline_saved');
    assert.equal(reads.length, 2);
    assert.deepEqual(pauses, [10_000]);
    assert.equal(reads.every((item) => item.method === 'GET' &&
      item.redirect === 'manual' &&
      new URL(item.url).pathname === '/api/v3/File'), true);
    const ledger = openShokoRecentLedger(dbPath);
    try {
      assert.equal(ledger.getCursor().fileId, 12);
      assert.deepEqual(ledger.nextDue(0), { fileId: 11 });
      assert.equal(ledger.getCapacity().pending, 2);
    } finally { ledger.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
