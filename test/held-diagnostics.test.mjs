import assert from 'node:assert/strict';
import test from 'node:test';
import { heldReporter, setHeldDiagnostics } from '../src/runtime/held-diagnostics.mjs';

test('a held result is unchanged whether or not reporting is on', () => {
  setHeldDiagnostics(null);
  const heldAfter = heldReporter('test/scope');
  assert.deepEqual(heldAfter(new Error('boom'), 'provider_unavailable'),
    { state: 'held', reason: 'provider_unavailable' });
  const seen = [];
  setHeldDiagnostics((entry) => seen.push(entry));
  try {
    assert.deepEqual(heldAfter(new Error('boom'), 'provider_unavailable'),
      { state: 'held', reason: 'provider_unavailable' });
    assert.deepEqual(seen, [{ scope: 'test/scope', reason: 'provider_unavailable',
      error: 'Error: boom' }]);
  } finally { setHeldDiagnostics(null); }
});

test('the same failure is reported once per ten minutes, and secrets are redacted', () => {
  let time = 0;
  const seen = [];
  setHeldDiagnostics((entry) => seen.push(entry), { now: () => time });
  try {
    const heldAfter = heldReporter('test/scope');
    const error = new TypeError('GET http://plex/library?X-Plex-Token=abc123 failed');
    heldAfter(error, 'plex_unavailable');
    heldAfter(error, 'plex_unavailable');
    time += 9 * 60 * 1000;
    heldAfter(error, 'plex_unavailable');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].error, 'TypeError: GET http://plex/library?X-Plex-Token=[redacted] failed');
    heldAfter(new Error('different'), 'plex_unavailable');
    assert.equal(seen.length, 2, 'a different message is reported straight away');
    time += 2 * 60 * 1000;
    heldAfter(error, 'plex_unavailable');
    assert.equal(seen.length, 3, 'reported again after ten minutes');
  } finally { setHeldDiagnostics(null); }
});

test('a failing writer never changes the result', () => {
  setHeldDiagnostics(() => { throw new Error('disk full'); });
  try {
    assert.deepEqual(heldReporter('test/scope')(new Error('x'), 'busy'), { state: 'held', reason: 'busy' });
  } finally { setHeldDiagnostics(null); }
});
