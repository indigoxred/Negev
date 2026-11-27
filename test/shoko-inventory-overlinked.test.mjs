import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoInventoryLedger } from '../src/availability/shoko-inventory-worker.mjs';

test('one file linked to over 100 episodes is recorded unverified and the pass continues', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-overlinked-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'state.sqlite'));
  try {
    const updated = '2026-11-01T00:00:00Z';
    const overlinked = { fileId: 10, updated, state: 'linked',
      pairs: Array.from({ length: 101 }, (_, index) => ({ anidbId: 42, episodeId: 1000 + index })) };
    const normal = { fileId: 11, updated, state: 'linked', pairs: [{ anidbId: 43, episodeId: 2001 }] };
    const expected = ledger.getCursor();
    const result = ledger.recordPage({ expected, observedMs: 5_000,
      result: { state: 'page', page: expected.page, total: 2, items: [overlinked, normal] } });
    assert.notEqual(result?.reason, 'invalid_file_page', 'the page must not be rejected');
    assert.notDeepEqual(ledger.getCursor(), expected, 'the cursor moves on');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 43, episodeId: 2001 }), [11],
      'the other file on the page is still recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1000 }), [],
      'the over-linked file gives no availability evidence');
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
