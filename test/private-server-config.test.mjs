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
    host: '127.0.0.1', port: 3000, airingPollEnabled: false,
  });
});

test('external binding requires an additional explicit private-test flag', () => {
  assert.throws(() => parsePrivateServerConfig({ ...env, NEGEV_LISTEN_HOST: '0.0.0.0' }), TypeError);
  assert.equal(parsePrivateServerConfig({ ...env, NEGEV_LISTEN_HOST: '0.0.0.0',
    NEGEV_EXPOSE_PRIVATE_TEST: '1' }).host, '0.0.0.0');
});

test('background Airing polling requires an explicit private-test flag', () => {
  assert.equal(parsePrivateServerConfig(env).airingPollEnabled, false);
  assert.equal(parsePrivateServerConfig({ ...env, NEGEV_PRIVATE_AIRING_POLL: '1' }).airingPollEnabled, true);
  assert.throws(() => parsePrivateServerConfig({ ...env, NEGEV_PRIVATE_AIRING_POLL: 'yes' }), TypeError);
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

test('optional Plex discovery requires a complete explicit section allowlist', () => {
  assert.deepEqual(parsePrivateServerConfig({ ...env,
    NEGEV_PLEX_URL: 'http://plex.internal:32400/',
    NEGEV_PLEX_TOKEN: 'synthetic-plex-token',
    NEGEV_PLEX_SECTIONS: 'episode:102,episode:103,movie:9',
  }).plexSections, { episode: [102, 103], movie: [9] });
  for (const invalid of [
    { NEGEV_PLEX_URL: 'http://plex.internal:32400/' },
    { NEGEV_PLEX_URL: 'http://plex.internal:32400/', NEGEV_PLEX_TOKEN: 'token' },
    { NEGEV_PLEX_URL: 'http://plex.internal:32400/', NEGEV_PLEX_TOKEN: 'token',
      NEGEV_PLEX_SECTIONS: 'episode:102,episode:102' },
    { NEGEV_PLEX_URL: 'http://plex.internal:32400/', NEGEV_PLEX_TOKEN: 'token',
      NEGEV_PLEX_SECTIONS: 'show:102' },
  ]) assert.throws(() => parsePrivateServerConfig({ ...env, ...invalid }), TypeError);
});
