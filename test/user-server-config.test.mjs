import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseUserServerConfig } from '../src/web/user-server-config.mjs';

const dataDir = path.resolve('private-negev-test');
const valid = { NEGEV_USER_SERVER: '1', NEGEV_DATA_DIR: dataDir,
  NEGEV_SHOKO_URL: 'http://shoko.internal:8111',
  NEGEV_SHOKO_API_KEY_FILE: path.join(dataDir, 'secrets', 'shoko.token'),
  NEGEV_PUBLIC_ORIGIN: 'http://localhost:3000' };

test('account-backed listener starts loopback only with explicit mode and data', () => {
  const parsed = parseUserServerConfig(valid);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.secureCookies, false);
  assert.equal(parsed.dbPath, path.join(dataDir, 'negev.sqlite'));
  assert.equal(parsed.sessionKeyPath, path.join(dataDir, 'session.key'));
  assert.equal(parsed.shokoApiKeyPath, path.join(dataDir, 'secrets', 'shoko.token'));
  assert.equal(Object.hasOwn(parsed, 'shokoApiKey'), false);
  assert.equal(parsed.shokoEvents, false);
  assert.equal(parseUserServerConfig({ ...valid, NEGEV_SHOKO_EVENTS: '1' }).shokoEvents, true);
});

test('non-loopback listener requires explicit exposure and HTTPS origin', () => {
  const exposed = { ...valid, NEGEV_LISTEN_HOST: '0.0.0.0',
    NEGEV_EXPOSE_USERS: '1', NEGEV_PUBLIC_ORIGIN: 'https://negev.example.test' };
  const parsed = parseUserServerConfig(exposed);
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.secureCookies, true);
  for (const change of [
    { NEGEV_EXPOSE_USERS: undefined },
    { NEGEV_PUBLIC_ORIGIN: 'http://negev.example.test' },
    { NEGEV_PUBLIC_ORIGIN: 'https://user:pass@negev.example.test' },
    { NEGEV_PUBLIC_ORIGIN: 'https://negev.example.test/path' },
  ]) assert.throws(() => parseUserServerConfig({ ...exposed, ...change }), TypeError);
});

test('incomplete or ambiguous user-server configuration fails closed', () => {
  for (const change of [
    { NEGEV_USER_SERVER: undefined }, { NEGEV_DATA_DIR: 'relative' },
    { NEGEV_SHOKO_API_KEY_FILE: '' },
    { NEGEV_SHOKO_API_KEY_FILE: 'relative.token' },
    { NEGEV_SHOKO_API_KEY_FILE: path.resolve('outside.token') },
    { NEGEV_SHOKO_API_KEY: 'synthetic-key' },
    { NEGEV_SHOKO_URL: 'http://user:pass@shoko.internal/' },
    { NEGEV_PUBLIC_ORIGIN: 'https://negev.example.test' },
    { NEGEV_PORT: '0' }, { NEGEV_PORT: '3000x' },
    { NEGEV_LISTEN_HOST: '192.168.1.1' },
    { NEGEV_SHOKO_EVENTS: 'yes' },
  ]) assert.throws(() => parseUserServerConfig({ ...valid, ...change }), TypeError);
});
