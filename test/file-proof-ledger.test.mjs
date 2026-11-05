import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';

const episode = { anidbId: 42, episodeId: 1001 };
const proof = { fileId: 7, libraryId: 102, ratingKey: 500, partId: 900 };

test('exact positive proofs persist and expire into previously available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 1_000;
  let ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
    now: () => clock });
  try {
    assert.deepEqual(ledger.getCurrent(episode), { state: 'unknown' });
    assert.deepEqual(ledger.observe({ ...episode, proof, checkedMs: 1_000 }),
      { state: 'recorded' });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 1_000 });
    ledger.close();
    ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
      now: () => clock });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 1_000 });
    clock = 1_300;
    assert.deepEqual(ledger.getCurrent(episode), {
      state: 'previously_available', verifiedAtMs: 1_000 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an alternate Plex card remains playable but retains its presentation note', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
    now: () => 1_000 });
  try {
    assert.deepEqual(ledger.observe({ ...episode,
      proof: { ...proof, presentation: 'alternate_card' }, checkedMs: 1_000 }),
    { state: 'recorded' });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 1_000, presentation: 'alternate_card' });
    ledger.close();
    ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
      now: () => 1_000 });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 1_000, presentation: 'alternate_card' });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a current exact card suppresses an alternate-card note', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  let clock = 1_200;
  const ledger = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 300, now: () => clock });
  try {
    ledger.observe({ ...episode, proof: { ...proof, fileId: 8 },
      checkedMs: 1_000 });
    ledger.observe({ ...episode,
      proof: { ...proof, presentation: 'alternate_card' },
      checkedMs: 1_100 });
    assert.deepEqual(ledger.getCurrent(episode),
      { state: 'available', verifiedAtMs: 1_000 });
    clock = 1_300;
    assert.deepEqual(ledger.getCurrent(episode),
      { state: 'available', verifiedAtMs: 1_100,
        presentation: 'alternate_card' });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an existing proof table gains a safe exact-card default', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE file_availability_proofs (
    anidb_id INTEGER NOT NULL,episode_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,library_id INTEGER NOT NULL,
    rating_key INTEGER NOT NULL,part_id INTEGER NOT NULL,
    verified_ms INTEGER NOT NULL,
    PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
  ) STRICT`);
  old.exec(`INSERT INTO file_availability_proofs VALUES
    (42,1001,7,102,500,900,1000)`);
  old.close();
  const ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
    now: () => 1_100 });
  try {
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 1_000 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one stale receipt cannot replace a newer proof or make another copy stale', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 2_000;
  const ledger = openFileProofLedger(dbPath, { positiveLifetimeMs: 300,
    now: () => clock });
  try {
    assert.deepEqual(ledger.observe({ ...episode, proof,
      checkedMs: 1_900 }), { state: 'recorded' });
    assert.deepEqual(ledger.observe({ ...episode, proof,
      checkedMs: 1_800 }), { state: 'stale' });
    assert.deepEqual(ledger.observe({ ...episode,
      proof: { ...proof, fileId: 8, ratingKey: 501, partId: 901 },
      checkedMs: 2_000 }), { state: 'recorded' });
    clock = 2_250;
    assert.deepEqual(ledger.getCurrent(episode), { state: 'available',
      verifiedAtMs: 2_000 });
    clock = 2_300;
    assert.deepEqual(ledger.getCurrent(episode), {
      state: 'previously_available', verifiedAtMs: 2_000 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('incomplete identities and future receipts cannot become available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const ledger = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 300, now: () => 1_000 });
  try {
    assert.deepEqual(ledger.observe({ ...episode,
      proof: { ...proof, partId: null }, checkedMs: 900 }),
    { state: 'held', reason: 'invalid_exact_proof' });
    assert.deepEqual(ledger.observe({ ...episode, proof,
      checkedMs: 1_001 }),
    { state: 'held', reason: 'invalid_exact_proof' });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'unknown' });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a bounded title read returns only currently proven episode IDs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const ledger = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 300, now: () => 1_500 });
  try {
    ledger.observe({ ...episode, proof, checkedMs: 1_400 });
    ledger.observe({ anidbId: 42, episodeId: 1002,
      proof: { ...proof, partId: 901 }, checkedMs: 1_000 });
    assert.deepEqual(ledger.getRecentAvailableIds({ anidbId: 42 }), [1001]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('library browse pages only exact current title proofs without duplicate files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  let clock = 1_500;
  const ledger = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 300, now: () => clock });
  try {
    ledger.observe({ anidbId: 41, episodeId: 101,
      proof: { ...proof, fileId: 41 }, checkedMs: 1_400 });
    ledger.observe({ anidbId: 42, episodeId: 201,
      proof: { ...proof, fileId: 42 }, checkedMs: 1_400 });
    ledger.observe({ anidbId: 42, episodeId: 201,
      proof: { ...proof, fileId: 43 }, checkedMs: 1_450 });
    ledger.observe({ anidbId: 42, episodeId: 202,
      proof: { ...proof, fileId: 44 }, checkedMs: 1_450 });
    ledger.observe({ anidbId: 43, episodeId: 301,
      proof: { ...proof, fileId: 45 }, checkedMs: 1_000 });
    assert.deepEqual(ledger.listCurrentTitles({ limit: 1 }), {
      items: [{ anidbId: 41, verifiedEpisodeCount: 1, lastVerifiedMs: 1_400 }],
      nextAfterAnidbId: 41,
    });
    assert.deepEqual(ledger.listCurrentTitles({ afterAnidbId: 41, limit: 10 }), {
      items: [{ anidbId: 42, verifiedEpisodeCount: 2, lastVerifiedMs: 1_450 }],
      nextAfterAnidbId: null,
    });
    clock = 1_800;
    assert.deepEqual(ledger.listCurrentTitles({ limit: 10 }),
      { items: [], nextAfterAnidbId: null });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a new observer session discards old positives but accepts fresh proofs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 1_000;
  let ledger = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => clock });
  try {
    ledger.observe({ ...episode, proof, checkedMs: 900 });
    ledger.close();
    ledger = openFileProofLedger(dbPath, {
      positiveLifetimeMs: 10_000, now: () => clock,
      discardPriorProofs: true });
    assert.deepEqual(ledger.getCurrent(episode), { state: 'unknown' });
    assert.deepEqual(ledger.getRecentAvailableIds({ anidbId: 42 }), []);
    clock = 1_001;
    ledger.observe({ ...episode, proof, checkedMs: 1_001 });
    assert.equal(ledger.getCurrent(episode).state, 'available');
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});
