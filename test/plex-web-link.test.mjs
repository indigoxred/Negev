import assert from 'node:assert/strict';
import test from 'node:test';
import { plexWebItemUrl, readPlexMachineIdentifier } from
  '../src/availability/plex-web-link.mjs';

const machineId = 'a'.repeat(40);

test('a verified Plex card opens in hosted Plex without a token in the URL', async () => {
  const calls = [];
  const found = await readPlexMachineIdentifier({
    baseUrl: 'http://plex:32400/', token: 'private-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ MediaContainer: { machineIdentifier: machineId } });
    },
  });
  assert.equal(found, machineId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['X-Plex-Token'], 'private-token');
  const link = plexWebItemUrl({ machineId: found, ratingKey: 502 });
  assert.equal(link, `https://app.plex.tv/desktop/#!/server/${machineId}` +
    '/details?key=%2Flibrary%2Fmetadata%2F502');
  assert.equal(link.includes('private-token'), false);
});

test('a bad or unavailable Plex identity cannot create a link', async () => {
  const unavailable = await readPlexMachineIdentifier({
    baseUrl: 'http://plex:32400/', token: 'private-token',
    fetchImpl: async () => Response.json({ MediaContainer: {
      machineIdentifier: 'bad/id' } }),
  });
  assert.equal(unavailable, null);
  assert.equal(plexWebItemUrl({ machineId: unavailable, ratingKey: 502 }), null);
  assert.equal(plexWebItemUrl({ machineId, ratingKey: 0 }), null);
  assert.equal(plexWebItemUrl({ machineId: 'bad/id', ratingKey: 502 }), null);
});
