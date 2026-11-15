import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canOpenSeasonRequest, relatedAvailabilityText,
  seasonRequestStatus, seasonSelectionSummary,
  seasonTriggerPresentation } from '../src/web/public/season-request-selection.mjs';

test('complete installment is already available while other seasons remain discoverable', () => {
  const current = { anidbId: 239, status: { state: 'available', selectable: false } };
  assert.deepEqual(seasonTriggerPresentation([current], 239, true), {
    showAvailable: true, showTrigger: true, triggerText: 'Find other seasons' });
  assert.deepEqual(seasonTriggerPresentation([current], 239, false), {
    showAvailable: true, showTrigger: false, triggerText: 'Find other seasons' });
  assert.deepEqual(seasonTriggerPresentation([current,
    { anidbId: 240, status: { state: 'partial', selectable: true } }], 239, false), {
    showAvailable: true, showTrigger: true, triggerText: 'Request other seasons' });
  assert.deepEqual(seasonTriggerPresentation([
    { anidbId: 239, status: { state: 'watching', selectable: true } }], 239, false), {
    showAvailable: false, showTrigger: true, triggerText: 'Watch future episodes' });
});

test('a partial installment offers completion while unverified installments offer a request', () => {
  const partial = { anidbId: 239, status: { state: 'partial', selectable: true } };
  assert.deepEqual(seasonTriggerPresentation([partial], 239, false), {
    showAvailable: false, showTrigger: true, triggerText: 'Complete season' });
  const unverified = { anidbId: 239, status: { state: 'unverified', selectable: true } };
  assert.deepEqual(seasonTriggerPresentation([unverified], 239, false), {
    showAvailable: false, showTrigger: true, triggerText: 'Request series' });
});

test('a later season page keeps Request series openable after a full first page', () => {
  const full = [{ status: { selectable: false }, requested: false }];
  assert.equal(canOpenSeasonRequest(full, true), true);
  assert.equal(canOpenSeasonRequest(full, false), false);
  assert.equal(canOpenSeasonRequest([{ status: { selectable: true }, requested: false }], false), true);
  assert.equal(canOpenSeasonRequest([{ status: { selectable: false },
    detailFailed: true, requested: false }], false), true);
});

test('season rows distinguish available, partial, unconfirmed and future without claiming files missing', () => {
  const base = { kind: 'series', episodes: [], nextPage: null };
  assert.deepEqual(seasonRequestStatus({ ...base, releaseState: 'upcoming',
    regularSeason: { verified: 0, total: 12 } }),
  { state: 'upcoming', text: 'Not yet released · request can be saved', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 12, total: 12 } }),
    { state: 'available', text: 'Available · 12/12', selectable: false });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 5, total: 12 } }),
    { state: 'partial', text: 'Partial · 5/12', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 0, total: 12 } }),
    { state: 'unverified', text: 'Availability unconfirmed · 0/12 verified', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, monitorFuture: true,
    regularSeason: { verified: 6, total: 6 } }),
  { state: 'watching', text: 'Available so far · watch future episodes', selectable: true });
  assert.deepEqual(seasonRequestStatus({ state: 'detail_pending' }),
    { state: 'unverified', text: 'Episode list not available yet · request can be queued', selectable: true });
  assert.deepEqual(seasonRequestStatus({ state: 'detail_unavailable' }),
    { state: 'unverified', text: 'Episode details unavailable · retry later', selectable: false });
  assert.deepEqual(seasonRequestStatus({ ...base, regularSeason: { verified: 0, total: 0 } }),
    { state: 'unverified', text: 'Episode list not published yet · request can be queued', selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...base, requestsOpen: false,
    regularSeason: { verified: 0, total: 11 } }),
    { state: 'unverified', text: 'Availability unconfirmed · 0/11 verified · requests not open yet', selectable: false });
  assert.equal(seasonRequestStatus({ ...base, kind: 'movie' }), null);
});

test('an unreleased installment has no availability language in its related row or review', () => {
  const upcoming = { kind: 'series', state: 'details', releaseState: 'upcoming',
    episodes: [], nextPage: null };
  assert.equal(relatedAvailabilityText(upcoming), 'Not yet released');
  assert.equal(seasonSelectionSummary([{ title: 'Future Season',
    status: seasonRequestStatus(upcoming) }]),
  'Future Season · watch for release and future episodes');
});

test('future scheduled entries do not make an aired-complete season partial', () => {
  const detail = { kind: 'series', episodes: [], nextPage: null,
    monitorFuture: true, regularSeason: { verified: 40, total: 44 },
    regularSchedule: { aired: 40, upcoming: 4, undated: 0,
      verifiedAired: 40, total: 44, asOf: '2026-11-13' } };
  assert.deepEqual(seasonRequestStatus(detail), {
    state: 'watching', text: 'Available so far · 40/40 aired · 4 upcoming',
    selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...detail,
    regularSeason: { verified: 39, total: 44 },
    regularSchedule: { ...detail.regularSchedule, verifiedAired: 39 } }), {
    state: 'partial', text: 'Partial · 39/40 aired · 4 upcoming',
    selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...detail,
    regularSeason: { verified: 0, total: 44 },
    regularSchedule: { ...detail.regularSchedule, verifiedAired: 0 } }), {
    state: 'unverified', text: 'Availability unconfirmed · 0/40 aired · 4 upcoming',
    selectable: true });
  assert.deepEqual(seasonRequestStatus({ ...detail,
    regularSeason: { verified: 0, total: 4 },
    regularSchedule: { aired: 0, upcoming: 4, undated: 0,
      verifiedAired: 0, total: 4, asOf: '2026-11-13' } }), {
    state: 'unverified', text: 'No aired episodes yet · 4 upcoming',
    selectable: true });
});

test('season review names each selected installment and partial completion', () => {
  assert.equal(seasonSelectionSummary([
    { title: 'Season One', status: { state: 'unverified' } },
    { title: 'Season Two', status: { state: 'partial' } },
  ]), 'Season One · request episodes not verified in Plex; Season Two · complete episodes not verified in Plex');
});
