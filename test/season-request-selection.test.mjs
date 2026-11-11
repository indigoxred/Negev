import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canOpenSeasonRequest, seasonRequestStatus, seasonSelectionSummary } from '../src/web/public/season-request-selection.mjs';

test('a later season page keeps Request series openable after a full first page', () => {
  const full = [{ status: { selectable: false }, requested: false }];
  assert.equal(canOpenSeasonRequest(full, true), true);
  assert.equal(canOpenSeasonRequest(full, false), false);
  assert.equal(canOpenSeasonRequest([{ status: { selectable: true }, requested: false }], false), true);
});

test('season rows distinguish available, partial, missing, future and unverified', () => {
  const base = { kind: 'series', episodes: [], nextPage: null };
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 12, total: 12 } }),
    { state: 'available', text: 'Available · 12/12', selectable: false });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 5, total: 12 } }),
    { state: 'partial', text: 'Partial · 5/12', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 0, total: 12 } }),
    { state: 'missing', text: 'Missing · 0/12', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, monitorFuture: true,
    regularSeason: { verified: 6, total: 6 } }),
  { state: 'watching', text: 'Available so far · watch future episodes', selectable: true });
  assert.deepEqual(seasonRequestStatus({ state: 'detail_pending' }),
    { state: 'unverified', text: 'Checking episode details', selectable: true });
  assert.equal(seasonRequestStatus({ ...base, kind: 'movie' }), null);
});

test('season review names each selected installment and partial completion', () => {
  assert.equal(seasonSelectionSummary([
    { title: 'Season One', status: { state: 'missing' } },
    { title: 'Season Two', status: { state: 'partial' } },
  ]), 'Season One · request missing episodes; Season Two · complete missing episodes');
});
