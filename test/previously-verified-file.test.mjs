import assert from 'node:assert/strict';
import test from 'node:test';
import { readPreviouslyVerifiedFile } from '../src/identity/previously-verified-file.mjs';

const physical = { dev: '1', ino: '2', mtimeNs: '3' };
const record = { ID: 5, Size: 1000, Hashes: [{ Type: 'ED2K', Value: 'e'.repeat(32) }],
  Locations: [{ FileID: 5, IsAccessible: true, AbsolutePath: '/pure/Anime/file.mkv' }] };
const input = { prior: { fileId: 5, size: 1000, physical },
  baseUrl: 'http://shoko:8111/', apiKey: 'test',
  shokoMount: { appRoot: '/pure', localRoot: process.cwd() },
  signal: new AbortController().signal,
  fetchImpl: async () => Response.json(record),
  statImpl: async () => ({ size: 1000n, dev: 1n, ino: 2n, mtimeNs: 3n,
    isFile: () => true, isSymbolicLink: () => false }) };

test('previous exact file requires the physical inode from its completed move', async () => {
  assert.deepEqual(await readPreviouslyVerifiedFile(input), { size: 1000, ed2k: 'e'.repeat(32) });
  assert.equal(await readPreviouslyVerifiedFile({ ...input,
    prior: { ...input.prior, physical: { ...physical, ino: '99' } } }), null);
});

test('unrelated, inaccessible and changed Shoko files never supply prior exact evidence', async () => {
  for (const change of [{ ID: 6 }, { Size: 999 }, { Hashes: [] },
    { Locations: [{ ...record.Locations[0], AbsolutePath: '/elsewhere/file.mkv' }] },
    { Locations: [{ ...record.Locations[0], IsAccessible: false }] }]) {
    assert.equal(await readPreviouslyVerifiedFile({ ...input,
      fetchImpl: async () => Response.json({ ...record, ...change }) }), null);
  }
});
