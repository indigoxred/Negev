import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisitionAccess } from '../src/acquisition/acquisition-access.mjs';
function fixture(overrides = {}) {
  const state = { allowed: true, restricted: true, calls: [], bonuses: [] };
  const authorize = createAcquisitionAccess({
    readRequest: () => ({ id: 1, requesterId: 2, anidbId: 42, kind: 'series', status: 'held' }),
    readAttempt: () => ({ requestId: 1 }), readUser: () => ({ id: 2, adultAllowed: state.allowed }),
    readBonuses: () => state.bonuses,
    loadDetail: async ({ anidbId }) => { state.calls.push(anidbId); return { state: 'details', anidbId, restricted: state.restricted }; },
    ...overrides });
  return { state, authorize };
}
test('each new acquisition authorization reads classification again, including after reclassification', async () => {
  const f = fixture(); f.state.allowed = false; f.state.restricted = false;
  assert.deepEqual(await f.authorize({ requestId: 1 }), { state: 'authorized', restricted: false });
  f.state.restricted = true;
  assert.equal((await f.authorize({ attemptId: 3 })).reason, 'adult_access_disabled');
  assert.deepEqual(f.state.calls, [42, 42]);
});
test('permission revocation while classification is pending is enforced before authorization returns', async () => {
  let finish; const f = fixture({ loadDetail: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.authorize({ requestId: 1 }); await new Promise(resolve => setImmediate(resolve));
  f.state.allowed = false; finish({ state: 'details', anidbId: 42, restricted: true });
  assert.equal((await pending).reason, 'adult_access_disabled');
});
test('a retained restricted bonus cannot ride along with an allowed main title', async () => {
  const f = fixture({ loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId, restricted: anidbId === 43 }) });
  f.state.allowed = false; f.state.bonuses = [{ anidbId: 43 }, { anidbId: 42 }];
  assert.equal((await f.authorize({ attemptId: 3 })).reason, 'adult_access_disabled');
});
for (const result of [null, { state: 'unavailable' }, { state: 'details', anidbId: 42 }, { state: 'details', anidbId: 43, restricted: false }])
  test('unknown or mismatched classification holds new work: ' + JSON.stringify(result), async () => {
    const f = fixture({ loadDetail: async () => result });
    assert.equal((await f.authorize({ requestId: 1 })).reason, 'restricted_or_unverified');
  });
test('a missing owner holds without querying external metadata', async () => {
  const f = fixture({ readUser: () => null });
  assert.equal((await f.authorize({ requestId: 1 })).reason, 'account_access_changed');
  assert.deepEqual(f.state.calls, []);
});
