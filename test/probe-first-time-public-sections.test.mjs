import assert from 'node:assert/strict';
import test from 'node:test';
import { probeFirstTimePublicSections } from
  '../src/availability/probe-first-time-public-sections.mjs';

const page = ({ libraryId, kind }) => ({ state: 'page', libraryId, kind,
  offset: 0, totalSize: 14, keys: [1], complete: false });
const source = (libraryId) => ({ libraryId, type: 'show',
  agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series',
  roots: ['/anime-native/!ShokoRelayVFS_CurrentSep30'] });

test('pins each public source before a first-time observation can proceed', async () => {
  const expectedSources = [source(102)];
  const calls = [];
  const result = await probeFirstTimePublicSections({ kind: 'series',
    publicSections: { episode: [102], movie: [] }, expectedSources,
    readSources: async ({ libraryIds }) => {
      calls.push(['sources', libraryIds]);
      return { state: 'source_snapshot', sections: [source(102)] };
    },
    readPage: async (input) => { calls.push(['page', input.libraryId]);
      return page(input); },
  });
  assert.deepEqual(calls, [['sources', [102]], ['page', 102]]);
  assert.equal(result.sourceVerified, true);
  for (const changed of [
    { agent: 'tv.plex.agents.series' },
    { scanner: 'Other Scanner' },
    { roots: ['/anime-native/direct'] },
  ]) {
    const held = await probeFirstTimePublicSections({ kind: 'series',
      publicSections: { episode: [102], movie: [] }, expectedSources,
      readSources: async () => ({ state: 'source_snapshot',
        sections: [{ ...source(102), ...changed }] }),
      readPage: async () => { throw Error('Source drift must stop page reads'); },
    });
    assert.deepEqual(held, { state: 'held', reason: 'public_source_unverified' });
  }
});

test('checks configured Plex sections without treating an AniDB episode ID as a Shoko GUID', async () => {
  const calls = [];
  const result = await probeFirstTimePublicSections({ kind: 'series',
    publicSections: { episode: [102, 103], movie: [54] },
    readPage: async (input) => { calls.push(input); return page(input); } });
  assert.deepEqual(calls, [
    { libraryId: 102, kind: 'episode', offset: 0, pageSize: 1 },
    { libraryId: 103, kind: 'episode', offset: 0, pageSize: 1 },
  ]);
  assert.deepEqual(result, { state: 'healthy_unconfirmed',
    libraryIds: [102, 103], parts: [], complete: false,
    probeCoverage: 'health_only', sourceVerified: false });
});

test('movie checks both configured episode and movie sections without claiming a missing title', async () => {
  const calls = [];
  const result = await probeFirstTimePublicSections({ kind: 'movie',
    publicSections: { episode: [102], movie: [123] },
    readPage: async (input) => { calls.push(input); return page(input); } });
  assert.deepEqual(calls.map(({ libraryId, kind }) => [libraryId, kind]),
    [[102, 'episode'], [123, 'movie']]);
  assert.equal(result.probeCoverage, 'health_only');
  assert.equal(result.complete, false);
});

test('an unavailable, partial or wrong library page holds', async () => {
  for (const bad of [
    { state: 'unavailable' },
    { ...page({ libraryId: 102, kind: 'episode' }), libraryId: 103 },
    { ...page({ libraryId: 102, kind: 'episode' }), totalSize: null },
    { ...page({ libraryId: 102, kind: 'episode' }), keys: [1, 2] },
  ]) {
    assert.deepEqual(await probeFirstTimePublicSections({ kind: 'series',
      publicSections: { episode: [102], movie: [] },
      readPage: async () => bad }),
    { state: 'held', reason: 'public_probe_unavailable' });
  }
  await assert.rejects(probeFirstTimePublicSections({ kind: 'movie',
    publicSections: { episode: [], movie: [] },
    readPage: async () => ({}) }), TypeError);
});
