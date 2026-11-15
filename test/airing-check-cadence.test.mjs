import assert from 'node:assert/strict';
import test from 'node:test';
import { airingCheckCadence } from '../src/requests/airing-check-cadence.mjs';

const nowMs = Date.parse('2026-11-15T00:00:00Z');
const base = { nowMs, today: '2026-11-15', state: 'upcoming',
  episodes: [] };

test('distant titles use weekly metadata and daily shared RSS', () => {
  assert.deepEqual(airingCheckCadence({ ...base, airDate: '2028-01-01' }),
    { metadataMs: 7 * 86_400_000, feedMs: 86_400_000 });
  assert.deepEqual(airingCheckCadence({ ...base, airDate: '2028' }),
    { metadataMs: 7 * 86_400_000, feedMs: 86_400_000 });
});

test('near titles tighten cadence and airing checks stay hourly', () => {
  assert.deepEqual(airingCheckCadence({ ...base, airDate: '2026-11-25' }),
    { metadataMs: 86_400_000, feedMs: 6 * 3_600_000 });
  assert.deepEqual(airingCheckCadence({ ...base, airDate: '2026-11-16' }),
    { metadataMs: 3_600_000, feedMs: 3_600_000 });
  assert.deepEqual(airingCheckCadence({ ...base, state: 'airing',
    airDate: '2026-10-01' }),
  { metadataMs: 3_600_000, feedMs: 3_600_000 });
});

test('unknown date gets daily metadata rather than a false long sleep', () => {
  assert.deepEqual(airingCheckCadence({ ...base, airDate: null }),
    { metadataMs: 86_400_000, feedMs: 6 * 3_600_000 });
});
