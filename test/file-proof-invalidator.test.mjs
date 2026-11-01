import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';
import { openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';
import { openPlexCardIndex } from
  '../src/availability/plex-card-index.mjs';

const target = { anidbId: 42, episodeId: 1001 };
const shokoFile = (fileId, updated = '2026-11-02T00:00:00Z') => ({
  fileId, updated, state: 'linked',
  pairs: [{ anidbId: 42, episodeId: 1001 }] });
const card = (ratingKey, suffix = 'a') => ({ libraryId: 102,
  ratingKey, kind: 'episode', parts: [{ libraryId: 102,
    partId: ratingKey + 100, size: 5,
    plexPath: `/source-pure/${ratingKey}-${suffix}.mkv` }] });

test('Shoko identity change withdraws only that file proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-invalidate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const proof = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  let shoko = openShokoInventoryLedger(dbPath);
  try {
    shoko.recordFileObservation({ item: shokoFile(7), observedMs: 100 });
    shoko.recordFileObservation({ item: shokoFile(8), observedMs: 100 });
    proof.observe({ ...target, proof: { fileId: 7, libraryId: 102,
      ratingKey: 500, partId: 600 }, checkedMs: 200 });
    proof.observe({ ...target, proof: { fileId: 8, libraryId: 102,
      ratingKey: 501, partId: 601 }, checkedMs: 210 });
    shoko.recordFileObservation({ item: { ...shokoFile(7),
      state: 'unverified', pairs: [] }, observedMs: 300 });
    assert.deepEqual(proof.getCurrent(target), { state: 'available',
      verifiedAtMs: 210 });
    shoko.close();
    shoko = openShokoInventoryLedger(dbPath);
    shoko.recordFileObservation({ item: { ...shokoFile(8),
      state: 'unverified', pairs: [] }, observedMs: 320 });
    assert.deepEqual(proof.getCurrent(target), { state: 'unknown' });
  } finally {
    shoko.close(); proof.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Plex card change withdraws matching proof but ignores an older observation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-invalidate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const proof = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  const plex = openPlexCardIndex(dbPath);
  try {
    plex.recordCard({ ...card(500), observedMs: 100 });
    proof.observe({ ...target, proof: { fileId: 7, libraryId: 102,
      ratingKey: 500, partId: 600 }, checkedMs: 200 });
    plex.recordCard({ ...card(500, 'b'), observedMs: 150 });
    assert.deepEqual(proof.getCurrent(target), { state: 'available',
      verifiedAtMs: 200 });
    plex.forgetCard({ libraryId: 102, ratingKey: 500, observedMs: 300 });
    assert.deepEqual(proof.getCurrent(target), { state: 'unknown' });
  } finally {
    plex.close(); proof.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a changed Plex Part withdraws only its card while another playable copy stays current', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-invalidate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const proof = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  const plex = openPlexCardIndex(dbPath);
  try {
    plex.recordCard({ ...card(500), observedMs: 100 });
    plex.recordCard({ ...card(501), observedMs: 100 });
    proof.observe({ ...target, proof: { fileId: 7, libraryId: 102,
      ratingKey: 500, partId: 600 }, checkedMs: 200 });
    proof.observe({ ...target, proof: { fileId: 8, libraryId: 102,
      ratingKey: 501, partId: 601 }, checkedMs: 210 });
    plex.recordCard({ ...card(500, 'changed-part'), observedMs: 300 });
    assert.deepEqual(proof.getCurrent(target), { state: 'available',
      verifiedAtMs: 210 });
    plex.recordCard({ ...card(501, 'changed-part'), observedMs: 320 });
    assert.deepEqual(proof.getCurrent(target), { state: 'unknown' });
  } finally {
    plex.close(); proof.close();
    await rm(dir, { recursive: true, force: true });
  }
});
