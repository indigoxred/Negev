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
  assert.equal(parsed.shokoInventoryHints, false);
  assert.equal(parsed.shokoRecent, false);
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_RECENT: '1' }).shokoRecent, true);
  assert.equal(parsed.shokoHydration, false);
  assert.equal(parsed.anidbTitleDump, false);
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_ANIDB_TITLE_DUMP: '1' }).anidbTitleDump, true);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_ANIDB_TITLE_DUMP: 'yes' }), TypeError);
  assert.equal(parsed.prowlarr, null);
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_HYDRATION: '1' }).shokoHydration, true);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_HYDRATION: 'yes' }), TypeError);
  assert.equal(parseUserServerConfig({ ...valid, NEGEV_SHOKO_INVENTORY: '1' }).shokoInventory, true);
  assert.equal(parseUserServerConfig({ ...valid, NEGEV_SHOKO_INVENTORY: '1',
    NEGEV_SHOKO_INVENTORY_HINTS: '1' }).shokoInventoryHints, true);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_INVENTORY_HINTS: '1' }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_INVENTORY: '1', NEGEV_SHOKO_INVENTORY_HINTS: 'yes' }), TypeError);
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

test('an exposed review listener may opt into its exact private LAN HTTP origin', () => {
  const exposed = { ...valid, NEGEV_LISTEN_HOST: '0.0.0.0',
    NEGEV_EXPOSE_USERS: '1', NEGEV_PORT: '17116',
    NEGEV_PUBLIC_ORIGIN: 'https://anime.negev.red',
    NEGEV_LOCAL_ORIGIN: 'http://192.168.50.138:17116' };
  assert.equal(parseUserServerConfig(exposed).localOrigin,
    exposed.NEGEV_LOCAL_ORIGIN);
  for (const local of ['http://192.168.50.138:17115',
    'http://8.8.8.8:17116', 'https://192.168.50.138:17116',
    'http://negev.example.test:17116',
    'http://user:pass@192.168.50.138:17116']) {
    assert.throws(() => parseUserServerConfig({ ...exposed,
      NEGEV_LOCAL_ORIGIN: local }), TypeError);
  }
  assert.throws(() => parseUserServerConfig({ ...exposed,
    NEGEV_EXPOSE_USERS: undefined }), TypeError);
});

test('a local tunnel can serve an HTTPS origin while Negev stays on loopback', () => {
  const tunnel = { ...valid, NEGEV_EXPOSE_USERS: '1',
    NEGEV_PUBLIC_ORIGIN: 'https://negev.example.test' };
  const parsed = parseUserServerConfig(tunnel);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.secureCookies, true);
  assert.throws(() => parseUserServerConfig({ ...tunnel,
    NEGEV_EXPOSE_USERS: undefined }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...tunnel,
    NEGEV_PUBLIC_ORIGIN: 'http://localhost:3000' }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_EXPOSE_USERS: 'yes' }), TypeError);
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
    { NEGEV_SHOKO_RECENT: 'yes' },
    { NEGEV_AIRING_WATCH: 'yes' },
    { NEGEV_AIRING_WATCH: '1' },
    { NEGEV_TIME_ZONE: 'Invalid/Timezone' },
  ]) assert.throws(() => parseUserServerConfig({ ...valid, ...change }), TypeError);
});

test('acquisition cannot be advertised as enabled before installed safety gates pass', () => {
  for (const secret of ['NEGEV_QBITTORRENT_PASSWORD',
    'NEGEV_QBITTORRENT_SID']) {
    assert.throws(() => parseUserServerConfig({ ...valid,
      [secret]: 'synthetic-secret' }), /qBittorrent credentials cannot use environment variables/);
  }
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_ACQUISITION_RUNTIME: '1' }), /Acquisition runtime is unavailable/);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_ACQUISITION_RUNTIME: 'yes' }), TypeError);
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_ACQUISITION_RUNTIME: '0' }).acquisitionRuntime, false);
});

test('acquisition opt-in requires guarded providers and portable staging paths', () => {
  const importRoot = path.resolve('sample-import-root');
  const configured = { ...valid,
    NEGEV_SHOKO_IMPORT_ROOT: importRoot,
    NEGEV_SHOKO_IMPORT_FOLDER_ID: '1',
    NEGEV_SHOKO_EVENTS: '1', NEGEV_SHOKO_RECENT: '1',
    NEGEV_DIRECT_AVAILABILITY: '1',
    NEGEV_PLEX_OBSERVER: '1', NEGEV_PLEX_GUID_PROBE: '1',
    NEGEV_PLEX_URL: 'http://plex.internal:32400',
    NEGEV_PLEX_TOKEN_FILE: path.join(dataDir, 'secrets', 'plex.token'),
    NEGEV_PLEX_SECTIONS: JSON.stringify({ episode: [102], movie: [] }),
    NEGEV_SHOKO_MEDIA_MOUNT: JSON.stringify({ appRoot: '/pure', localRoot: path.resolve('media') }),
    NEGEV_PLEX_MEDIA_MOUNTS: JSON.stringify([{ appRoot: '/anime', localRoot: path.resolve('media') }]),
    NEGEV_PLEX_SOURCE_POLICY: JSON.stringify([{ libraryId: 102, type: 'show',
      agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series', roots: ['/anime/Relay'] }]),
    NEGEV_PROWLARR_DISCOVERY: '1', NEGEV_PROWLARR_URL: 'http://prowlarr.internal:9696',
    NEGEV_PROWLARR_KEY_FILE: path.join(dataDir, 'secrets', 'prowlarr.token'),
    NEGEV_PROWLARR_INDEXERS: '[5]',
    NEGEV_QBITTORRENT_SIDECAR_READ: '1',
    NEGEV_QBITTORRENT_URL: 'http://qbittorrent.internal:8080',
    NEGEV_QBITTORRENT_USERNAME: 'observer',
    NEGEV_QBITTORRENT_PASSWORD_FILE: path.join(dataDir, 'secrets', 'qbittorrent.password'),
    NEGEV_QBITTORRENT_IMPORT_SAVE_PATH: '/Shoko',
    NEGEV_STAGING_HOST_PATH: path.resolve('staging'),
    NEGEV_QBITTORRENT_STAGING_ROOT: '/data/torrents/negev',
    NEGEV_HOLDING_ROOT: path.resolve('handoff', 'holding'),
    NEGEV_ACQUISITION_IMPORT_PARENT: path.resolve('handoff', 'source'),
    NEGEV_ACQUISITION_IMPORT_FOLDER_ID: '2',
    NEGEV_ACQUISITION_SHOKO_SOURCE_PATH: '/negev/source',
    NEGEV_SHOKO_RELEASE_PROVIDER_ID: '11111111-2222-3333-4444-555555555555',
    NEGEV_ACQUISITION_RUNTIME: '1' };
  const parsed = parseUserServerConfig(configured);
  assert.equal(parsed.acquisitionRuntime, true);
  assert.deepEqual(parsed.acquisition, {
    stagingHostPath: configured.NEGEV_STAGING_HOST_PATH,
    qbitStagingRoot: configured.NEGEV_QBITTORRENT_STAGING_ROOT,
    holdingRoot: configured.NEGEV_HOLDING_ROOT,
    importRoot: path.join(configured.NEGEV_ACQUISITION_IMPORT_PARENT, 'Negev'),
    shokoSourcePath: '/negev/source', shokoSourceFolderId: 2,
    shokoProviderId: configured.NEGEV_SHOKO_RELEASE_PROVIDER_ID,
  });
  for (const change of [
    { NEGEV_PROWLARR_DISCOVERY: '0' },
    { NEGEV_SHOKO_EVENTS: '0' },
    { NEGEV_SHOKO_RECENT: '0' },
    { NEGEV_DIRECT_AVAILABILITY: '0' },
    { NEGEV_PLEX_SOURCE_POLICY: undefined },
    { NEGEV_QBITTORRENT_SIDECAR_READ: '0' },
    { NEGEV_STAGING_HOST_PATH: importRoot },
    { NEGEV_HOLDING_ROOT: path.join(importRoot, 'holding') },
    { NEGEV_HOLDING_ROOT: importRoot },
    { NEGEV_HOLDING_ROOT: configured.NEGEV_STAGING_HOST_PATH },
    { NEGEV_ACQUISITION_IMPORT_PARENT: undefined },
    { NEGEV_ACQUISITION_IMPORT_FOLDER_ID: undefined },
    { NEGEV_ACQUISITION_IMPORT_FOLDER_ID: '1' },
    { NEGEV_ACQUISITION_SHOKO_SOURCE_PATH: undefined },
    { NEGEV_ACQUISITION_SHOKO_SOURCE_PATH: '/negev/../source' },
    { NEGEV_ACQUISITION_IMPORT_PARENT: importRoot },
    { NEGEV_ACQUISITION_IMPORT_PARENT: path.join(importRoot, 'Negev') },
    { NEGEV_ACQUISITION_IMPORT_PARENT: configured.NEGEV_HOLDING_ROOT },
    { NEGEV_ACQUISITION_IMPORT_PARENT: path.resolve('other', 'source') },
    { NEGEV_QBITTORRENT_STAGING_ROOT: '/data/torrents/../outside' },
    { NEGEV_QBITTORRENT_STAGING_ROOT: '/' },
    { NEGEV_QBITTORRENT_STAGING_ROOT: '/Shoko' },
    { NEGEV_QBITTORRENT_STAGING_ROOT: '/Shoko/negev' },
    { NEGEV_MOUNT_WITNESS_SOCKET: path.join(dataDir, 'docker.sock') },
    { NEGEV_SHOKO_RELEASE_PROVIDER_ID: 'bad' },
  ]) assert.throws(() => parseUserServerConfig({ ...configured, ...change }), TypeError);
});

test('optional read-only Shoko Import root must be a normalized absolute path', () => {
  assert.equal(parseUserServerConfig(valid).shokoImportRoot, null);
  const root = path.resolve('sample-import-root');
  assert.equal(parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_IMPORT_ROOT: root }).shokoImportRoot, root);
  for (const bad of ['', 'relative', path.parse(root).root,
    `${root}${path.sep}..`,
    `${root}\nother`]) {
    assert.throws(() => parseUserServerConfig({ ...valid,
      NEGEV_SHOKO_IMPORT_ROOT: bad }), TypeError);
  }
});

test('recognized Import observation is opt-in and scopes its qBittorrent secret', () => {
  const root = path.resolve('sample-import-root');
  const scoped = { ...valid, NEGEV_SHOKO_IMPORT_ROOT: root,
    NEGEV_SHOKO_IMPORT_FOLDER_ID: '1' };
  assert.equal(parseUserServerConfig(valid).shokoImportFolderId, null);
  assert.equal(parseUserServerConfig(scoped).shokoImportFolderId, 1);
  const withQbit = { ...scoped, NEGEV_QBITTORRENT_SIDECAR_READ: '1',
    NEGEV_QBITTORRENT_URL: 'http://qbittorrent.internal:8080',
    NEGEV_QBITTORRENT_USERNAME: 'observer',
    NEGEV_QBITTORRENT_PASSWORD_FILE:
      path.join(dataDir, 'secrets', 'qbittorrent.password'),
    NEGEV_QBITTORRENT_IMPORT_SAVE_PATH: '/Shoko' };
  assert.deepEqual(parseUserServerConfig(withQbit).qbitSidecar, {
    baseUrl: withQbit.NEGEV_QBITTORRENT_URL,
    username: 'observer',
    passwordPath: withQbit.NEGEV_QBITTORRENT_PASSWORD_FILE,
    importSavePath: '/Shoko' });
  for (const change of [
    { NEGEV_QBITTORRENT_SIDECAR_READ: '0' },
    { NEGEV_QBITTORRENT_USERNAME: '' },
    { NEGEV_QBITTORRENT_PASSWORD_FILE: path.resolve('other.password') },
    { NEGEV_QBITTORRENT_IMPORT_SAVE_PATH: '/Shoko/../Other' },
    { NEGEV_QBITTORRENT_URL: 'http://user:pass@qbittorrent.internal:8080' },
    { NEGEV_SHOKO_IMPORT_FOLDER_ID: '0' },
    { NEGEV_SHOKO_IMPORT_ROOT: undefined },
  ]) assert.throws(() => parseUserServerConfig({ ...withQbit, ...change }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_SHOKO_IMPORT_FOLDER_ID: '1' }), TypeError);
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
  assert.equal(parsed.plex.sourcePolicy, null);
  const sourcePolicy = [{ libraryId: 102, type: 'show',
    agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series',
    roots: ['/anime-native/Relay'] },
  { libraryId: 9, type: 'movie', agent: 'com.plexapp.agents.themoviedb',
    scanner: 'Plex Movie', roots: ['/movies'] }];
  assert.deepEqual(parseUserServerConfig({ ...plex,
    NEGEV_PLEX_SOURCE_POLICY: JSON.stringify(sourcePolicy) }).plex.sourcePolicy,
  sourcePolicy);
  for (const policy of [sourcePolicy.slice(0, 1),
    [{ ...sourcePolicy[0], roots: ['/wrong'] }, sourcePolicy[0]],
    [{ ...sourcePolicy[0], roots: ['/'] }, sourcePolicy[1]],
    [{ ...sourcePolicy[0], agent: '' }, sourcePolicy[1]],
    [{ ...sourcePolicy[0], type: 'movie' }, sourcePolicy[1]]]) {
    assert.throws(() => parseUserServerConfig({ ...plex,
      NEGEV_PLEX_SOURCE_POLICY: JSON.stringify(policy) }), TypeError);
  }
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_PLEX_SOURCE_POLICY: JSON.stringify(sourcePolicy) }), TypeError);
  assert.equal(Object.hasOwn(parsed.plex, 'plexToken'), false);
  assert.equal(parsed.plexIndex, false);
  assert.equal(parsed.fileBackfill, false);
  assert.equal(parsed.directAvailability, false);
  assert.equal(parsed.directActiveDelayMs, 60_000);
  assert.equal(parsed.titleCheck, false);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_TITLE_CHECK: '1' }).titleCheck, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_GUID_PROBE: '1',
    NEGEV_TITLE_CHECK: '1' }).titleCheck, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_GUID_PROBE: '1',
    NEGEV_TITLE_CHECK: '1', NEGEV_DIRECT_ACTIVE_DELAY_MS: '10000' })
    .directActiveDelayMs, 10_000);
  const proofReader = parseUserServerConfig({ ...plex,
    NEGEV_FILE_PROOF_READ: '1',
    NEGEV_FILE_PROOF_LIFETIME_MS: String(24 * 60 * 60_000) });
  assert.equal(proofReader.fileBackfill, false);
  assert.equal(proofReader.fileProofLifetimeMs, 24 * 60 * 60_000);
  assert.equal(parsed.plex.guidProbe, false);
  assert.equal(parseUserServerConfig({ ...plex,
    NEGEV_PLEX_GUID_PROBE: '1' }).plex.guidProbe, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1' }).plexIndex, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1' })
    .plexIndexIntervalMs, 60_000);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_PLEX_INDEX_INTERVAL_MS: '15000' }).plexIndexIntervalMs, 15_000);
  for (const interval of ['0', '14999', '300001', '15000.5', 'abc']) {
    assert.throws(() => parseUserServerConfig({ ...plex,
      NEGEV_PLEX_INDEX: '1', NEGEV_PLEX_INDEX_INTERVAL_MS: interval }), TypeError);
  }
  assert.throws(() => parseUserServerConfig({ ...plex,
    NEGEV_PLEX_INDEX_INTERVAL_MS: '15000' }), TypeError);
  const backfill = { ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_SHOKO_INVENTORY: '1', NEGEV_SHOKO_INVENTORY_HINTS: '1',
    NEGEV_FILE_BACKFILL: '1', NEGEV_FILE_BACKFILL_INTERVAL_MS: '10000',
    NEGEV_FILE_PROOF_LIFETIME_MS: String(3 * 24 * 60 * 60_000) };
  assert.equal(parseUserServerConfig(backfill).fileBackfill, true);
  assert.equal(parseUserServerConfig(backfill).fileBackfillIntervalMs, 10_000);
  assert.equal(parseUserServerConfig(backfill).fileBackfillFilesPerTick, 1);
  assert.equal(parseUserServerConfig({ ...backfill,
    NEGEV_FILE_BACKFILL_FILES_PER_TICK: '4' }).fileBackfillFilesPerTick, 4);
  assert.equal(parseUserServerConfig(backfill).fileProofLifetimeMs,
    3 * 24 * 60 * 60_000);
  for (const change of [
    { NEGEV_SHOKO_INVENTORY_HINTS: '0' },
    { NEGEV_PLEX_INDEX: '0' },
    { NEGEV_FILE_BACKFILL_INTERVAL_MS: '9999' },
    { NEGEV_FILE_BACKFILL_FILES_PER_TICK: '0' },
    { NEGEV_FILE_BACKFILL_FILES_PER_TICK: '11' },
    { NEGEV_FILE_BACKFILL_FILES_PER_TICK: '4.5' },
    { NEGEV_FILE_PROOF_LIFETIME_MS: undefined },
    { NEGEV_FILE_PROOF_LIFETIME_MS: '0' },
  ]) assert.throws(() => parseUserServerConfig({ ...backfill, ...change }),
    TypeError);
  assert.throws(() => parseUserServerConfig({ ...plex,
    NEGEV_FILE_BACKFILL_FILES_PER_TICK: '4' }), TypeError);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_SHOKO_INVENTORY: '1', NEGEV_DIRECT_AVAILABILITY: '1' }).directAvailability, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_SHOKO_RECENT: '1', NEGEV_DIRECT_AVAILABILITY: '1' }).directAvailability, true);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_GUID_PROBE: '1',
    NEGEV_SHOKO_RECENT: '1', NEGEV_DIRECT_AVAILABILITY: '1' }).directAvailability, true);
  assert.throws(() => parseUserServerConfig({ ...plex,
    NEGEV_SHOKO_RECENT: '1', NEGEV_DIRECT_AVAILABILITY: '1' }), TypeError);
  assert.equal(parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_SHOKO_RECENT: '1', NEGEV_DIRECT_AVAILABILITY: '1',
    NEGEV_DIRECT_ACTIVE_DELAY_MS: '15000' }).directActiveDelayMs, 15_000);
  assert.throws(() => parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
    NEGEV_SHOKO_EVENTS: '1', NEGEV_DIRECT_AVAILABILITY: '1' }), TypeError);
  for (const change of [
    { NEGEV_PLEX_TOKEN: 'secret' },
    { NEGEV_PLEX_TOKEN_FILE: path.join(dataDir, 'secrets', 'shoko.token') },
    { NEGEV_PLEX_SECTIONS: '{bad' },
    { NEGEV_PLEX_SECTIONS: JSON.stringify({ episode: [102], movie: [102] }) },
    { NEGEV_PLEX_MEDIA_MOUNTS: JSON.stringify([{ appRoot: '/',
      localRoot: dataDir }]) },
    { NEGEV_PLEX_OBSERVER: '0' },
    { NEGEV_PLEX_INDEX: 'yes' },
    { NEGEV_DIRECT_AVAILABILITY: '1' },
    { NEGEV_DIRECT_AVAILABILITY: 'yes' },
    { NEGEV_DIRECT_ACTIVE_DELAY_MS: '15000' },
    { NEGEV_TITLE_CHECK: '1' },
    { NEGEV_TITLE_CHECK: 'yes' },
  ]) assert.throws(() => parseUserServerConfig({ ...plex, ...change }), TypeError);
  for (const delay of ['0', '9999', '300001', '15s', '015000']) {
    assert.throws(() => parseUserServerConfig({ ...plex, NEGEV_PLEX_INDEX: '1',
      NEGEV_SHOKO_RECENT: '1', NEGEV_DIRECT_AVAILABILITY: '1',
      NEGEV_DIRECT_ACTIVE_DELAY_MS: delay }), TypeError);
  }
  assert.throws(() => parseUserServerConfig({ ...valid, NEGEV_PLEX_INDEX: '1' }), TypeError);
  assert.throws(() => parseUserServerConfig({ ...valid,
    NEGEV_PLEX_GUID_PROBE: '1' }), TypeError);
});
