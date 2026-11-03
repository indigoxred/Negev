import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetirementArgs } from '../src/admin/retire-stalled.mjs';

test('operator must name one attempt and exact hash and confirm staged-file deletion', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(parseRetirementArgs(['7', hash, '--delete-staged-files']),
    { attemptId: 7, hash });
  for (const args of [[], ['7', hash], ['0', hash, '--delete-staged-files'],
    ['7', 'all', '--delete-staged-files'],
    ['7', hash, '--delete-staged-files', '--extra']]) {
    assert.throws(() => parseRetirementArgs(args), TypeError);
  }
});
