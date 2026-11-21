import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';

async function select({ betterTitle, worseTitle, betterSeeds, worseSeeds,
  pack = false, maxPreflights = 3 }) {
  const episodeIds = pack ? [1001, 1002] : [1001];
  const request = { id: 4, anidbId: 42, kind: 'series', status: 'held', episodeIds };
  const items = [
    { guid: 'better', title: `Example ${betterTitle}`, seeders: betterSeeds },
    { guid: 'exact', title: `Example ${worseTitle}`, seeders: worseSeeds },
  ].map(x => ({ ...x, indexerId: 7, size: 1000, evidence: 'unverified' }));
  let selected;
  const processor = createAcquisitionRequestProcessor({
    readRequest: () => request, requireReleasePolicy: true,
    preferShokoPreview: true, maxPreflights,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, releaseState: pack ? 'completed' : 'airing', items }),
    previewCandidate: async ({ candidate }) => ({ state: 'preflight',
      requestId: 4, anidbId: 42, torrentHash: 'a'.repeat(40), episodeIds,
      shokoPreview: candidate.guid === 'exact' ? 'exact' : 'uncertain',
      files: episodeIds.map((id, i) => ({ name: `Example - 0${i + 1}.mkv`,
        size: 1000, episodeIds: [id] })) }),
    loadDetail: async () => ({ state: 'details', complete: true, total: episodeIds.length,
      anidbId: 42, title: 'Example', kind: 'series', restricted: false,
      episodes: episodeIds.map((id, i) => ({ id, number: i + 1, type: 'Episode' })) }),
    submitCandidate: async ({ candidate }) => {
      selected = candidate.guid;
      return { state: 'stopped_observed', attemptId: 11 };
    },
  });
  let result;
  for (let pass = 1; pass <= 5 && !selected; pass++) {
    result = await processor({ requestId: 4, pass,
      candidateOffset: result?.nextCandidateOffset ?? 0,
      candidateFingerprint: result?.nextCandidateFingerprint ?? null });
  }
  assert.equal(result.state, 'stopped_observed');
  return selected;
}

for (const pack of [false, true]) {
  for (const maxPreflights of pack ? [1, 3] : [3]) {
    for (const [better, worse] of [['WEB 1080p', 'WEB 480p'],
      ['WEB 1080p', 'WEB 720p'], ['BD 1080p', 'WEB 1080p']]) {
      for (const worseSeeds of [1, 2, 3, 10]) {
        test(`stronger ${better} survives recognition preference: pack=${pack}, page=${maxPreflights}, seeds=10/${worseSeeds}, alternative=${worse}`, async () => {
          assert.equal(await select({ betterTitle: `${pack ? 'Season 1 ' : '- 01 '}${better}`,
            worseTitle: `${pack ? 'Season 1 ' : '- 01 '}${worse}`,
            betterSeeds: 10, worseSeeds, pack, maxPreflights }), 'better');
        });
      }
    }
  }
}

test('same viable quality tier retains exact filename-recognition preference', async () => {
  assert.equal(await select({ betterTitle: '- 01 WEB 1080p', worseTitle: '- 01 WEB 1080p',
    betterSeeds: 10, worseSeeds: 3 }), 'exact');
});

test('healthy same-quality alternative beats barely seeded exact filename prediction', async () => {
  assert.equal(await select({ betterTitle: '- 01 WEB 1080p', worseTitle: '- 01 WEB 1080p',
    betterSeeds: 10, worseSeeds: 2 }), 'better');
});

test('seeded1080p is not downgraded merely because720p reports more peers', async () => {
  assert.equal(await select({ betterTitle: '- 01 WEB 1080p', worseTitle: '- 01 WEB 720p',
    betterSeeds: 1, worseSeeds: 10 }), 'better');
});

test('720p remains available when the1080p release has no reported seeders',async()=>{
 assert.equal(await select({betterTitle:'- 01 WEB 1080p',worseTitle:'- 01 WEB 720p',betterSeeds:0,worseSeeds:10}),'exact');
});
