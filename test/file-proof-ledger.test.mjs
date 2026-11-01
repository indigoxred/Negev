import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
