import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestKeyStore, generateRequestKey } from '../src/web/public/request-key.mjs';

test('a LAN HTTP browser can generate a key without randomUUID', () => {
  const cryptoSource = { getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = index;
    return bytes;
  } };
  assert.equal(generateRequestKey(cryptoSource),
    '000102030405060708090a0b0c0d0e0f');
  assert.throws(() => generateRequestKey({}), /random/i);
});

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
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'film-entry-1001' }), 'key-4');
  keys.saved({ userId: 4, anidbId: 42 });
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-5');
  assert.equal(keys.pending({ userId: 5, anidbId: 42 }), 'key-2');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'episode-1001' }), 'key-3');
});
