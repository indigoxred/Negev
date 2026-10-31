import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoOneFile } from '../src/availability/shoko-one-file.mjs';

const base = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key', fileId: 10 };
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test('event-triggered read checks only the exact Shoko file ID', async () => {
  const result = await readShokoOneFile({ ...base, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/api/v3/File/10');
    assert.deepEqual(url.searchParams.getAll('include'), ['XRefs']);
    assert.equal(init.method, 'GET');
    return json({ ID: 10, Updated: '2026-10-31T00:00:00Z',
      SeriesIDs: [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [{ AniDB: 1001 }] }] });
  } });
  assert.deepEqual(result, { state: 'file', item: {
    fileId: 10, updated: '2026-10-31T00:00:00Z', state: 'linked',
    pairs: [{ anidbId: 42, episodeId: 1001 }],
  } });
});

test('404, wrong file ID, and provider outage never assert deletion', async () => {
  assert.deepEqual(await readShokoOneFile({ ...base,
    fetchImpl: async () => new Response('', { status: 404 }) }),
  { state: 'unavailable' });
  assert.deepEqual(await readShokoOneFile({ ...base,
    fetchImpl: async () => json({ ID: 11, Updated: '2026-10-31T00:00:00Z', SeriesIDs: [] }) }),
  { state: 'unavailable' });
  await assert.rejects(readShokoOneFile({ ...base, fileId: 0,
    fetchImpl: async () => { throw new Error('must not fetch'); } }), TypeError);
});
