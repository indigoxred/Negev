import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { reconcileParentWatch } from '../src/requests/parent-watch-reconcile.mjs';

const map = { version: 2, anime: [{ anidb_id: 11, tvdb_id: 100 }] };
const detail = (anidbId, extra = {}) => ({ state: 'details', anidbId,
  kind: 'series', title: `Anime ${anidbId}`, airDate: '2026-11-01',
  endDate: null, episodeCount: 12, restricted: false,
  complete: true, total: 1,
  episodes: [{ id: anidbId * 100, type: 'Episode', airDate: '2026-11-01' }],
  ...extra });
async function withLedgers(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-watch-reconcile-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const requests = openRequestLedger(dbPath);
  const parents = openParentWatchLedger(dbPath);
  try {
    parents.adopt({ tvdbId: 100, requesterId: 7,
      sourceSeriesId: 42, nowMs: 1000 });
    await run({ requests, parents });
  } finally {
    parents.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const noRelations = async (id) => ({ state: 'related_titles',
  anidbId: id, items: [] });

test('creates one durable Airing watch for an exact mapped installment', async () =>
  withLedgers(async ({ requests, parents }) => {
    const input = { parent: parents.listActive({ limit: 10 })[0], map,
      parents, requests, loadDetail: async ({ anidbId }) => detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 };
    const first = await reconcileParentWatch(input);
    assert.deepEqual(first, { state: 'reconciled', created: [11], existing: [],
      skipped: [] });
    const record = parents.listInstallments({ tvdbId: 100 });
    assert.equal(record.length, 1);
    assert.equal(requests.getRequest(record[0].requestId).monitorFuture, true);
    assert.deepEqual((await reconcileParentWatch(input)).created, []);
    assert.equal(requests.countRequests(), 1);
  }));

test('a completed mapped installment is skipped without a download target', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, {
        endDate: '2026-11-02' }), readRelations: noRelations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, []);
    assert.equal(requests.countRequests(), 0);
  }));

test('a reciprocal sequel absent from AniMap becomes a separate watch', async () =>
  withLedgers(async ({ requests, parents }) => {
    const relations = async (id) => ({ state: 'related_titles', anidbId: id,
      items: id === 11 ? [{ anidbId: 12, relation: 'Sequel' }] :
        [{ anidbId: 11, relation: 'Prequel' }] });
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, anidbId === 11
        ? { endDate: '2026-11-02' } : {}), readRelations: relations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, [12]);
    assert.deepEqual(parents.listInstallments({ tvdbId: 100 })
      .map((item) => item.anidbId), [12]);
  }));

test('a later reciprocal sequel is found from a previously recorded successor', async () =>
  withLedgers(async ({ requests, parents }) => {
    const relations = async (id) => ({ state: 'related_titles', anidbId: id,
      items: id === 11 ? [{ anidbId: 12, relation: 'Sequel' }] :
        id === 12 ? [{ anidbId: 11, relation: 'Prequel' },
          { anidbId: 13, relation: 'Sequel' }] :
          [{ anidbId: 12, relation: 'Prequel' }] });
    const parent = parents.listActive({ limit: 10 })[0];
    const input = { parent, map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId,
        anidbId === 11 ? { endDate: '2026-11-02' } : {}),
      readRelations: relations, today: '2026-11-12', nowMs: 2000 };
    const first = await reconcileParentWatch(input);
    assert.deepEqual(first.created, [12]);
    const second = await reconcileParentWatch(input);
    assert.deepEqual(second.created, [13]);
    assert.equal(requests.countRequests(), 2);
  }));

test('incomplete detail holds a candidate and does not create a watch', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async () => ({ state: 'unavailable' }),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 });
    assert.equal(result.state, 'reconciled');
    assert.deepEqual(result.heldCandidates, [11]);
    assert.equal(requests.countRequests(), 0);
  }));

test('one old missing detail does not block a later active mapped installment', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0],
      map: { version: 2, anime: [
        { anidb_id: 11, tvdb_id: 100 }, { anidb_id: 12, tvdb_id: 100 }] },
      parents, requests,
      loadDetail: async ({ anidbId }) => anidbId === 11
        ? { state: 'unavailable' } : detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, [12]);
    assert.deepEqual(result.heldCandidates, [11]);
  }));

test('an old undated incomplete season is held, not misread as airing', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, {
        airDate: '2012-01-01', episodeCount: 12, total: 1,
        episodes: [{ id: 1001, type: 'Episode', airDate: '2012-01-01' }],
      }), readRelations: noRelations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.heldCandidates, [11]);
    assert.equal(requests.countRequests(), 0);
  }));

test('a claimed installment retries a failed submit without duplicate requests', async () =>
  withLedgers(async ({ requests, parents }) => {
    const parent = parents.listActive({ limit: 10 })[0];
    const input = { parent, map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 };
    let failed = false;
    const flakyRequests = { submit(args) {
      const result = requests.submit(args);
      if (!failed) { failed = true; throw new Error('crashed after submit'); }
      return result;
    } };
    await assert.rejects(reconcileParentWatch({ ...input, requests: flakyRequests }),
      /crashed after submit/);
    assert.deepEqual(parents.listInstallments({ tvdbId: 100 }),
      [{ anidbId: 11, requestId: null }]);
    assert.deepEqual((await reconcileParentWatch(input)).existing, [11]);
    assert.equal(requests.countRequests(), 1);
    assert.equal(parents.listInstallments({ tvdbId: 100 })[0].requestId, 1);
  }));
