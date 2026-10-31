import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { prepareRecordedHandoff } from '../src/acquisition/prepare-recorded-handoff.mjs';
import { ed2kFile } from '../src/identity/ed2k.mjs';

test('recorded exact batch is copied privately and journaled once, without publishing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recorded-handoff-'));
  const dbPath = path.join(root, 'state.sqlite');
  const stagingRoot = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir)));
  const name = '01.mkv';
  const source = path.join(stagingRoot, name);
  await writeFile(source, Buffer.from('registered sample'));
  const hash = await ed2kFile(source);
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const torrentHash = 'a'.repeat(40);
  const candidate = { indexerId: 7, guid: 'one' };
  const reserved = acquisitions.reserve({ requestId: saved.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  acquisitions.bindPreparedTorrent({ attemptId: reserved.attemptId, candidate,
    hash: torrentHash, nowMs: 201 });
  acquisitions.recordFilePlan({ attemptId: reserved.attemptId, hash: torrentHash,
    plannedFiles: [{ name, size: hash.size, episodeIds: [1001] }], nowMs: 201 });
  acquisitions.beginDispatch({ attemptId: reserved.attemptId, nowMs: 202 });
  acquisitions.recordTorrent({ attemptId: reserved.attemptId, hash: torrentHash, nowMs: 203 });
  acquisitions.beginStart({ attemptId: reserved.attemptId, hash: torrentHash,
    manifestDigest: 'b'.repeat(64), nowMs: 204 });
  const handoffs = openHandoffLedger(dbPath);
  let observations = 0;
  const run = () => prepareRecordedHandoff({ requests, acquisitions, handoffs,
    attemptId: reserved.attemptId, stagingRoot, holdingRoot, importRoot,
    observe: async () => { observations++; return { state: 'complete', files: [
      { index: 0, name, size: hash.size }], subtitles: [] }; },
    lookup: async () => null,
    verify: async () => ({ state: 'identity_verified', fileId: 51,
      ed2k: hash.ed2k, size: hash.size,
      coverage: [{ episodeId: 1001, start: 0, end: 100 }] }),
    nowMs: 205, readPacer: { afterBytes: async () => {} } });
  try {
    const first = await run();
    assert.equal(first.state, 'handoff_prepared');
    assert.deepEqual(await readFile(path.join(first.holdingPath, name)),
      await readFile(source));
    assert.deepEqual(await readdir(importRoot), []);
    assert.equal(handoffs.getHandoff(reserved.attemptId).status, 'prepared');
    const again = await run();
    assert.deepEqual(again, { state: 'held', reason: 'handoff_already_recorded' });
    assert.equal(observations, 2);
    assert.equal((await readdir(holdingRoot)).length, 1);
  } finally {
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});
