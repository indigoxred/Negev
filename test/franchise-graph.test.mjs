import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleAniDbFranchise } from '../src/catalogue/franchise-graph.mjs';

const row = (anidbId, items) => ({ state: 'relations', anidbId, items });
const edge = (relatedId, type = 'Sequel', verified = true) =>
  ({ relatedId, type, verified });

test('verified relation rows group transitive candidate installments only', () => {
  const result = assembleAniDbFranchise({ seedId: 42, relationRows: [
    row(42, [edge(43), edge(99, 'SharedCharacters')]),
    row(43, [edge(42, 'Prequel'), edge(44, 'SideStory')]),
    row(44, [edge(43, 'MainStory')]),
  ] });
  assert.deepEqual(result, { state: 'related_installments', completeness: 'unproven', seedId: 42,
    installmentIds: [42, 43, 44] });
});

test('a missing relation row leaves explicit frontier instead of claiming one franchise', () => {
  assert.deepEqual(assembleAniDbFranchise({ seedId: 42,
    relationRows: [row(42, [edge(43)])] }),
  { state: 'pending', reason: 'relation_rows_missing', frontier: [43] });
});

test('unverified or contradictory edges hold the grouping', () => {
  assert.deepEqual(assembleAniDbFranchise({ seedId: 42,
    relationRows: [row(42, [edge(43, 'Sequel', false)])] }),
  { state: 'held', reason: 'unverified_relation' });
  assert.deepEqual(assembleAniDbFranchise({ seedId: 42,
    relationRows: [row(42, [edge(43)]), row(43, [])] }),
  { state: 'held', reason: 'relation_not_reciprocal' });
});
