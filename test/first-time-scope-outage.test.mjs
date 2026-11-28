import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createUserService } from '../src/web/user-service.mjs';

test('a failed public identity lease remains a retryable first-time observation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-first-time-scope-'));
  const service = await createUserService({ dbPath: path.join(dir, 'state.sqlite'),
    shokoBaseUrl: 'http://shoko.invalid/', shokoApiKey: 'synthetic',
    sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000', secureCookies: false,
    plex: { plexBaseUrl: 'http://plex.invalid/', plexToken: 'synthetic',
      publicSections: { episode: [102], movie: [] },
      sourcePolicy: [{ libraryId: 102, type: 'show', agent: 'shoko',
        scanner: 'Plex TV Series', roots: ['/plex'] }],
      shokoMount: { appRoot: '/shoko', localRoot: dir },
      plexMount: { appRoot: '/plex', localRoot: dir } },
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  try {
    assert.deepEqual(await service.observeFirstTimeUncertain({
      anidbId: 42, episodeIds: [1001], kind: 'series' }),
    { state: 'held', reason: 'availability_unavailable' });
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});
