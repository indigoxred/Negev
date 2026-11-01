import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlexLibrarySources } from
  '../src/availability/plex-library-sources.mjs';

const row = (key, change = {}) => ({ key: String(key), type: 'show',
  agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series',
  Location: [{ path: '/anime-native/!ShokoRelayVFS_CurrentSep30' }],
  ...change });
const response = (rows, status = 200) => new Response(JSON.stringify({
  MediaContainer: { size: rows.length, Directory: rows },
}), { status, headers: { 'content-type': 'application/json' } });

test('reads only configured Plex source identities and roots from the section list', async () => {
  const calls = [];
  const result = await readPlexLibrarySources({
    baseUrl: 'http://plex.internal:32400/', token: 'private-test-token',
    libraryIds: [102, 103], fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method,
        token: init.headers['X-Plex-Token'] });
      return response([row(102), row(103), row(54, { type: 'movie' })]);
    },
  });
  assert.deepEqual(calls, [{ url: 'http://plex.internal:32400/library/sections',
    method: 'GET', token: 'private-test-token' }]);
  assert.deepEqual(result, { state: 'source_snapshot', sections: [
    { libraryId: 102, type: 'show', agent: 'tv.plex.agents.custom.shoko',
      scanner: 'Plex TV Series',
      roots: ['/anime-native/!ShokoRelayVFS_CurrentSep30'] },
    { libraryId: 103, type: 'show', agent: 'tv.plex.agents.custom.shoko',
      scanner: 'Plex TV Series',
      roots: ['/anime-native/!ShokoRelayVFS_CurrentSep30'] },
  ] });
});

test('missing, duplicated, or malformed source records fail closed', async () => {
  for (const rows of [
    [row(103)],
    [row(102), row(102)],
    [row(102, { Location: [{ path: '/anime/../other' }] })],
    [row(102, { Location: [] })],
    [row(102, { agent: '' })],
  ]) {
    const result = await readPlexLibrarySources({
      baseUrl: 'http://plex.internal:32400/', token: 'private-test-token',
      libraryIds: [102], fetchImpl: async () => response(rows),
    });
    assert.deepEqual(result, { state: 'unavailable' });
  }
});

test('provider failure and unsafe request scope do not yield a source snapshot', async () => {
  assert.deepEqual(await readPlexLibrarySources({
    baseUrl: 'http://plex.internal:32400/', token: 'private-test-token',
    libraryIds: [102], fetchImpl: async () => response([], 503),
  }), { state: 'unavailable' });
  await assert.rejects(readPlexLibrarySources({
    baseUrl: 'http://plex.internal:32400/', token: 'private-test-token',
    libraryIds: [102, 102], fetchImpl: async () => response([row(102)]),
  }), TypeError);
});
