import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';
import { openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';
import { openPlexCardIndex } from
  '../src/availability/plex-card-index.mjs';

const target = { anidbId: 42, episodeId: 1001 };
const item = (updated = '2026-11-02T00:00:00Z') => ({ fileId: 7,
  updated, state: 'linked', pairs: [target] });
const card = (suffix = 'a', candidateKey = '1:2:5') => ({
  libraryId: 102, ratingKey: 500, kind: 'episode',
  parts: [{ libraryId: 102, partId: 600, size: 5,
    plexPath: `/source-pure/episode-${suffix}.mkv`, candidateKey }] });
const snapshot = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const source = db.prepare(`SELECT updated,observed_ms AS observedMs
      FROM shoko_inventory_files WHERE file_id=7`).get();
    const cardRevision = db.prepare(`SELECT observed_ms AS observedMs,
      identity_signature AS identitySignature FROM plex_card_observations
      WHERE library_id=102 AND rating_key=500`).get();
    return { source, card: cardRevision };
  } finally { db.close(); }
};

test('a late proof insert cannot escape an already delivered Shoko change', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const shoko = openShokoInventoryLedger(dbPath);
  const plex = openPlexCardIndex(dbPath);
  const proofs = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  try {
    shoko.recordFileObservation({ item: item(), observedMs: 100 });
    plex.recordCard({ ...card(), observedMs: 100 });
    const revision = snapshot(dbPath);
    shoko.recordFileObservation({ item: item('2026-11-02T01:00:00Z'),
      observedMs: 250 });
    assert.deepEqual(proofs.observeGuarded({ ...target, checkedMs: 300,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' }, revision }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'unknown' });
  } finally {
    proofs.close(); plex.close(); shoko.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a changed Plex card or physical Part cannot receive a late exact proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const shoko = openShokoInventoryLedger(dbPath);
  const plex = openPlexCardIndex(dbPath);
  const proofs = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  try {
    shoko.recordFileObservation({ item: item(), observedMs: 100 });
    plex.recordCard({ ...card(), observedMs: 100 });
    const revision = snapshot(dbPath);
    plex.recordCard({ ...card('b', '1:3:5'), observedMs: 250 });
    const proof = { fileId: 7, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5' };
    assert.deepEqual(proofs.observeGuarded({ ...target, proof,
      checkedMs: 300, revision }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.observeGuarded({ ...target, proof,
      checkedMs: 300, revision: snapshot(dbPath) }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'unknown' });
    assert.deepEqual(proofs.observeGuarded({ ...target,
      proof: { ...proof, storageKey: '1:3:5' }, checkedMs: 300,
      revision: snapshot(dbPath) }), { state: 'recorded' });
    assert.deepEqual(proofs.observeGuarded({ ...target,
      proof: { ...proof, storageKey: '1:3:5',
        presentation: 'alternate_card' }, checkedMs: 301,
      revision: snapshot(dbPath) }), { state: 'recorded' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'available',
      verifiedAtMs: 301, presentation: 'alternate_card' });
  } finally {
    proofs.close(); plex.close(); shoko.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a proof holds when its source ledgers are not installed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const proofs = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 1_000, now: () => 500 });
  try {
    assert.deepEqual(proofs.observeGuarded({ ...target, checkedMs: 300,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' },
      revision: { source: { updated: '2026-11-02T00:00:00Z',
        observedMs: 100 }, card: { observedMs: 100,
        identitySignature: 'synthetic' } } }),
    { state: 'held', reason: 'source_generation_changed' });
  } finally { proofs.close(); await rm(dir, { recursive: true, force: true }); }
});
