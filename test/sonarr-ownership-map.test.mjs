import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSonarrOwnership } from '../src/acquisition/sonarr-ownership-map.mjs';

const anime = [
  { anidb_id: 10, tvdb_id: 100, episodes: [] },
  { anidb_id: 11, tvdb_id: 100, episodes: [] },
  { anidb_id: 12, tvdb_id: 200, episodes: [] },
  { anidb_id: 13, episodes: [{ tvdb: [{ series: 100, season: 0, episode: 1 }] }] },
];

test('blocks every AniDB installment of a monitored Sonarr TVDB series', () => {
  const result = mapSonarrOwnership({ version: 2, anime }, [
    { id: 1, monitored: true, tvdbId: 100 },
    { id: 2, monitored: false, tvdbId: 200 },
  ]);
  assert.deepEqual(result, { state: 'ready', monitoredSeries: 1,
    ownedAnidbIds: new Set([10, 11, 13]),
    knownAnidbIds: new Set([10, 11, 12, 13]) });
});

test('fails closed when any monitored series lacks a TVDB mapping', () => {
  assert.deepEqual(mapSonarrOwnership({ version: 2, anime }, [
    { id: 1, monitored: true, tvdbId: 100 },
    { id: 3, monitored: true, tvdbId: 999 },
  ]), { state: 'held', reason: 'sonarr_identity_unmapped' });
});

test('fails closed on malformed Sonarr data or unsupported map version', () => {
  assert.deepEqual(mapSonarrOwnership({ version: 3, anime }, []),
    { state: 'held', reason: 'ownership_map_invalid' });
  assert.deepEqual(mapSonarrOwnership({ version: 2, anime }, [
    { id: 1, monitored: true, tvdbId: null },
  ]), { state: 'held', reason: 'sonarr_identity_unmapped' });
});
