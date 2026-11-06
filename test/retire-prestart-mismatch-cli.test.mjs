import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrestartMismatchArgs } from
  '../src/admin/retire-prestart-mismatch.mjs';

test('retirement CLI requires one exact attempt, hash, and torrent-only flag', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(parsePrestartMismatchArgs(['6', hash,
    '--remove-torrent-only']), { attemptId: 6, hash });
  for (const args of [[], ['6', hash], ['6', hash, '--delete-staged-files'],
    ['0', hash, '--remove-torrent-only'],
    ['6', 'not-a-hash', '--remove-torrent-only']]) {
    assert.throws(() => parsePrestartMismatchArgs(args), TypeError);
  }
});
