import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';

const request = { id: 1, anidbId: 42, kind: 'series', episodeIds: [1001] };
const candidate = { indexerId: 7, guid: 'private-candidate-guid', title: 'Example - 01', size: 1000 };

test('deterministic candidate evidence survives restart without raw GUIDs; transient failures do not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-candidate-cache-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 100, cache = openCandidateCheckCache(dbPath, { now: () => clock });
  try {
    const key = { request, candidate };
    cache.put({ ...key, result: { state: 'held', reason: 'shoko_preview_wrong_identity' } });
    cache.close(); cache = openCandidateCheckCache(dbPath, { now: () => clock });
    assert.equal(cache.get(key).reason, 'shoko_preview_wrong_identity');
    assert.equal(cache.get({ ...key, candidate: { ...candidate, size: 999 } }), null);
    cache.put({ ...key, candidate: { ...candidate, guid: 'outage' },
      result: { state: 'held', reason: 'provider_unavailable' } });
    assert.equal(cache.get({ ...key, candidate: { ...candidate, guid: 'outage' } }), null);
    cache.invalidateTarget({ anidbId: 42, episodeId: 1001 });
    assert.equal(cache.get(key), null);
    cache.close();
    assert.equal((await readFile(dbPath)).includes(Buffer.from(candidate.guid)), false);
    cache = openCandidateCheckCache(dbPath, { now: () => clock });
  } finally { cache.close(); await rm(dir, { recursive: true, force: true }); }
});
