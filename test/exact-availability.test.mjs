import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExactAvailability } from '../src/availability/exact-availability.mjs';

const target = { anidbId: 1234, episodeId: 1001 };
const file = { fileId: 51, anidbId: 1234, episodeIds: [1001], storageKey: 'verified-storage-key-a' };
const part = { storageKey: file.storageKey, libraryId: 102, readable: true };
const shoko = { state: 'ok', complete: true, files: [file] };
const plex = { state: 'ok', complete: true, parts: [part] };
const evaluate = (overrides = {}) => evaluateExactAvailability({ target, shoko, plex,
  publicLibraryIds: [102], ...overrides });

test('exact Shoko episode plus public playable Plex part is available without request ownership', () => {
  assert.deepEqual(evaluate(), { state: 'available', fileId: 51 });
});

test('wrong anime or episode never counts even when Plex has the same bytes', () => {
  assert.deepEqual(evaluate({ shoko: { ...shoko, files: [{ ...file, anidbId: 9999 }] } }),
    { state: 'absent' });
  assert.deepEqual(evaluate({ shoko: { ...shoko, files: [{ ...file, episodeIds: [1002] }] } }),
    { state: 'absent' });
});

test('Shoko-only, private Plex and unreadable parts are not available', () => {
  assert.deepEqual(evaluate({ plex: { ...plex, parts: [] } }), { state: 'awaiting_plex' });
  assert.deepEqual(evaluate({ plex: { ...plex, parts: [{ ...part, libraryId: 130 }] } }),
    { state: 'awaiting_plex' });
  assert.deepEqual(evaluate({ plex: { ...plex, parts: [{ ...part, readable: false }] } }),
    { state: 'held', reason: 'plex_part_unreadable' });
});

test('duplicate encodes and one multi-episode file preserve exact identity', () => {
  const second = { ...file, fileId: 52, storageKey: 'verified-storage-key-b' };
  assert.deepEqual(evaluate({ shoko: { ...shoko, files: [file, second] },
    plex: { ...plex, parts: [{ ...part, storageKey: second.storageKey }] } }),
  { state: 'available', fileId: 52 });
  assert.deepEqual(evaluate({ shoko: { ...shoko, files: [{ ...file, episodeIds: [1001, 1002] }] } }),
    { state: 'available', fileId: 51 });
});

test('conflicting Shoko claims for the same storage key hold', () => {
  assert.deepEqual(evaluate({ shoko: { ...shoko, files: [file, { ...file,
    fileId: 52, anidbId: 9999 }] } }),
  { state: 'held', reason: 'conflicting_storage_identity' });
});

test('outage or incomplete observation is unknown, not absence', () => {
  for (const input of [
    { shoko: { state: 'unavailable' } },
    { shoko: { ...shoko, complete: false, files: [] } },
    { plex: { state: 'unavailable' } },
    { plex: { ...plex, complete: false, parts: [] } },
  ]) assert.deepEqual(evaluate(input), { state: 'unknown', reason: 'observer_incomplete' });
});
