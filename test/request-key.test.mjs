import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestKeyStore } from '../src/web/public/request-key.mjs';

test('an uncertain retry reuses its key but a saved request permits another', () => {
  const values = new Map();
  let sequence = 0;
  const keys = createRequestKeyStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    createKey: () => `key-${++sequence}`,
  });
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-1');
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-1');
  assert.equal(keys.pending({ userId: 5, anidbId: 42 }), 'key-2');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'episode-1001' }), 'key-3');
  keys.saved({ userId: 4, anidbId: 42 });
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-4');
  assert.equal(keys.pending({ userId: 5, anidbId: 42 }), 'key-2');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'episode-1001' }), 'key-3');
});
