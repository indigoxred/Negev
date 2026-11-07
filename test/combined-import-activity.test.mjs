import assert from 'node:assert/strict';
import test from 'node:test';
import { combineImportActivity } from '../src/availability/combined-import-activity.mjs';

const fp = (digit) => digit.repeat(64);

test('two quiet Shoko sources must both be stable and retain scoped pending keys', () => {
  const manual = { state: 'quiet_observed', fingerprint: fp('a') };
  const automated = { state: 'quiet_observed', fingerprint: fp('b'),
    unrelatedPendingKeys: ['2:Negev/negev-1-aabbccddeeff0011/01.mkv'] };
  const result = combineImportActivity(manual, automated, true);
  assert.equal(result.state, 'quiet_observed');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.unrelatedPendingKeys, automated.unrelatedPendingKeys);
  assert.notEqual(combineImportActivity({ ...manual, fingerprint: fp('c') },
    automated, true).fingerprint, result.fingerprint);
  assert.deepEqual(combineImportActivity(manual,
    { state: 'busy' }, true), { state: 'busy' });
  assert.deepEqual(combineImportActivity({ state: 'unavailable' },
    automated, true), { state: 'unavailable' });
  assert.deepEqual(combineImportActivity(manual,
    { ...automated, fingerprint: 'bad' }, true), { state: 'unavailable' });
  assert.deepEqual(combineImportActivity(manual, automated),
    { state: 'quiet_observed' });
});

test('a single busy source retains its safe diagnostic reason', () => {
  const quiet = { state: 'quiet_observed', fingerprint: fp('a') };
  const automated = { state: 'busy', reason: 'active_or_unknown_sidecar' };
  assert.deepEqual(combineImportActivity(quiet, automated), automated);
  assert.deepEqual(combineImportActivity(automated, quiet), automated);
  assert.deepEqual(combineImportActivity(automated,
    { state: 'busy', reason: 'unrecognized_import_video' }), { state: 'busy' });
});
