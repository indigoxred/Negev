import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseUserServerConfig, dateInZone } from '../src/web/user-server-config.mjs';

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
  assert.equal(parsed.shokoInventory, false);
  assert.equal(parsed.shokoHydration, false);
  assert.equal(parsed.prowlarr, null);
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_HYDRATION: '1' }).shokoHydration, true);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_HYDRATION: 'yes' }), TypeError);
  assert.equal(parseUserServerConfig({ ...valid, NEGEV_SHOKO_INVENTORY: '1' }).shokoInventory, true);
  assert.equal(parsed.airingWatch, false);
  assert.equal(parseUserServerConfig({ ...valid, NEGEV_AIRING_WATCH: '1',
    NEGEV_TIME_ZONE: 'Australia/Sydney' }).airingWatch, true);
});

test('read-only Prowlarr discovery is opt-in and uses a private key file', () => {
  const configured = { ...valid, NEGEV_PROWLARR_DISCOVERY: '1',
    NEGEV_PROWLARR_URL: 'http://prowlarr.internal:9696',
    NEGEV_PROWLARR_KEY_FILE: path.join(dataDir, 'secrets', 'prowlarr.token'),
    NEGEV_PROWLARR_INDEXERS: '[7,9]' };
  assert.deepEqual(parseUserServerConfig(configured).prowlarr, {
    baseUrl: configured.NEGEV_PROWLARR_URL,
    keyPath: configured.NEGEV_PROWLARR_KEY_FILE,
    indexerIds: [7, 9] });
  for (const change of [
    { NEGEV_PROWLARR_DISCOVERY: '0' },
    { NEGEV_PROWLARR_KEY_FILE: path.join(dataDir, 'secrets', 'plex.token') },
    { NEGEV_PROWLARR_API_KEY: 'synthetic' },
    { NEGEV_PROWLARR_INDEXERS: '[7,7]' },
    { NEGEV_PROWLARR_INDEXERS: '[]' },
    { NEGEV_PROWLARR_INDEXERS: '[0]' },
    { NEGEV_PROWLARR_URL: 'http://user:pass@prowlarr.internal:9696' },
  ]) assert.throws(() => parseUserServerConfig({ ...configured, ...change }), TypeError);
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
    { NEGEV_SHOKO_INVENTORY: 'yes' },
    { NEGEV_AIRING_WATCH: 'yes' },
    { NEGEV_AIRING_WATCH: '1' },
    { NEGEV_TIME_ZONE: 'Invalid/Timezone' },
  ]) assert.throws(() => parseUserServerConfig({ ...valid, ...change }), TypeError);
});

test('Airing date uses the configured local calendar day', () => {
  const moment = new Date('2026-10-31T13:30:00Z');
  assert.equal(dateInZone('Australia/Sydney', moment), '2026-11-01');
  assert.equal(dateInZone('UTC', moment), '2026-10-31');
});

test('opt-in Plex observer requires scoped public sections, mounts and a private token file', () => {
  const plex = { ...valid, NEGEV_PLEX_OBSERVER: '1',
    NEGEV_PLEX_URL: 'http://plex.internal:32400',
    NEGEV_PLEX_TOKEN_FILE: path.join(dataDir, 'secrets', 'plex.token'),
    NEGEV_PLEX_SECTIONS: JSON.stringify({ episode: [102], movie: [9] }),
    NEGEV_SHOKO_MEDIA_MOUNT: JSON.stringify({ appRoot: '/pure',
      localRoot: path.join(dataDir, 'media') }),
    NEGEV_PLEX_MEDIA_MOUNTS: JSON.stringify([{ appRoot: '/source-pure',
      localRoot: path.join(dataDir, 'media') }]) };
  const parsed = parseUserServerConfig(plex);
  assert.equal(parsed.plex.plexBaseUrl, plex.NEGEV_PLEX_URL);
  assert.equal(parsed.plex.plexTokenPath, plex.NEGEV_PLEX_TOKEN_FILE);
  assert.deepEqual(parsed.plex.publicSections, { episode: [102], movie: [9] });
  assert.equal(Object.hasOwn(parsed.plex, 'plexToken'), false);
  assert.equal(parsed.plexIndex, false);
  assert.equal(parsed.plex.guidProbe, false);
  assert.equal(parseUserServerConfig({ ...plex,
    NEGEV_PLEX_GUID_PROBE: '1' }).plex.guidProbe, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1' }).plexIndex, true);
  for (const change of [
    { NEGEV_PLEX_TOKEN: 'secret' },
    { NEGEV_PLEX_TOKEN_FILE: path.join(dataDir, 'secrets', 'shoko.token') },
    { NEGEV_PLEX_SECTIONS: '{bad' },
    { NEGEV_PLEX_SECTIONS: JSON.stringify({ episode: [102], movie: [102] }) },
    { NEGEV_PLEX_MEDIA_MOUNTS: JSON.stringify([{ appRoot: '/',
      localRoot: dataDir }]) },
    { NEGEV_PLEX_OBSERVER: '0' },
    { NEGEV_PLEX_INDEX: 'yes' },
  ]) assert.throws(() => parseUserServerConfig({ ...plex, ...change }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid, NEGEV_PLEX_INDEX: '1' }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_PLEX_GUID_PROBE: '1' }), TypeError);
});
