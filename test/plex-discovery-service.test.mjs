import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCatalogueTestService } from '../src/catalogue/catalogue-service.mjs';

test('private service reads only explicitly allowed Plex sections', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-plex-discovery-'));
  const calls = [];
  const service = createCatalogueTestService({
    shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic',
    dbPath: path.join(dir, 'claims.sqlite'), testToken: 'synthetic-private-token',
    plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic-plex-token',
    plexSections: { episode: [102], movie: [9] },
    fetchImpl: async (url, options) => {
      calls.push(url.pathname);
      assert.equal(options.headers['X-Plex-Token'], 'synthetic-plex-token');
      if (url.pathname === '/library/sections/102') {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } });
      }
      return Response.json({ MediaContainer: { size: 1, totalSize: 1, offset: 0,
        librarySectionID: 102, Metadata: [{ ratingKey: '512', type: 'episode',
          librarySectionID: 102 }] } });
    },
  });
  const auth = { authorization: 'Bearer synthetic-private-token' };
  try {
    const denied = await service.app.inject({ method: 'GET',
      url: '/api/availability/plex/keys?kind=episode&libraryId=103', headers: auth });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(calls, []);
    const allowed = await service.app.inject({ method: 'GET',
      url: '/api/availability/plex/keys?kind=episode&libraryId=102', headers: auth });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().keys, [512]);
    assert.equal(allowed.json().complete, false);
    assert.deepEqual(calls, ['/library/sections/102', '/library/sections/102/all']);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
