import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrivateServerConfig } from '../src/web/private-server-config.mjs';

const env = { NEGEV_PRIVATE_TEST: '1', NEGEV_SHOKO_URL: 'http://shoko.internal:8111',
  NEGEV_SHOKO_API_KEY: 'synthetic-key', NEGEV_TEST_TOKEN: 'synthetic-private-token',
  NEGEV_DATA_DIR: '/tmp/negev-private' };

test('private catalogue server binds only loopback by default', () => {
  assert.deepEqual(parsePrivateServerConfig(env), {
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-key',
    testToken: 'synthetic-private-token', dataDir: '/tmp/negev-private',
    host: '127.0.0.1', port: 3000,
  });
});

test('external binding requires an additional explicit private-test flag', () => {
  assert.throws(() => parsePrivateServerConfig({ ...env, NEGEV_LISTEN_HOST: '0.0.0.0' }), TypeError);
  assert.equal(parsePrivateServerConfig({ ...env, NEGEV_LISTEN_HOST: '0.0.0.0',
    NEGEV_EXPOSE_PRIVATE_TEST: '1' }).host, '0.0.0.0');
});

test('missing test flag or credentials and invalid ports fail before listening', () => {
  for (const invalid of [
    { ...env, NEGEV_PRIVATE_TEST: '0' },
    { ...env, NEGEV_SHOKO_API_KEY: '' },
    { ...env, NEGEV_TEST_TOKEN: 'short' },
    { ...env, NEGEV_PORT: '65536' },
    { ...env, NEGEV_PORT: '3000x' },
  ]) assert.throws(() => parsePrivateServerConfig(invalid), TypeError);
});
