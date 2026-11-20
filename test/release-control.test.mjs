import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';

const candidate = { guid: 'private-release-a', indexerId: 1,
  title: '[Group] Example - 01 [1080p]', size: 1000, seeders: 20 };
const preview = { torrentHash: 'a'.repeat(40), episodeIds: [101],
  files: [{ name: 'Example - 01.mkv', size: 1000, episodeIds: [101] }] };
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-choice-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let requests = openRequestLedger(dbPath);
  const acquisitions = openAcquisitionLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'choice', nowMs: 100,
    releaseMode: 'manual', intent: { state: 'ready', anidbId: 42,
      kind: 'series', monitorFuture: false, episodeIds: [101, 102] } });
  const reopen = () => { requests.close(); requests = openRequestLedger(dbPath); return requests; };
  try { await run({ requests, acquisitions, id: saved.requestId, reopen }); }
  finally { requests.close(); acquisitions.close(); await rm(dir, { recursive: true, force: true }); }
}
test('manual mode is atomic with submission and blocks an already-searching automatic worker', () => fixture(({requests, acquisitions, id}) => {
  assert.equal(requests.getReleaseControl(id, 100).phase, 'selecting');
  assert.equal(acquisitions.reserve({ requestId: id, candidate,
    episodeIds: [101], nowMs: 101 }).reason, 'release_selection_pending');
}));
test('exact choices survive restart and prevent substitution and stale selection writes', () => fixture(({requests, acquisitions, id, reopen}) => {
  const control = requests.getReleaseControl(id, 100);
  assert.equal(requests.updateReleaseControl(id, control.revision, { mode: 'manual',
    phase: 'chosen', selection: { candidate, preview } }, 101).state, 'updated');
  const reopened = reopen();
  assert.equal(reopened.getReleaseControl(id, 102).selection.preview.torrentHash, preview.torrentHash);
  assert.equal(reopened.updateReleaseControl(id, control.revision, {mode:'auto',phase:'consumed'}, 102).reason, 'stale_release_selection');
  assert.equal(acquisitions.reserve({requestId:id,candidate:{...candidate,guid:'another'},episodeIds:[101],nowMs:103}).reason,'release_choice_changed');
  assert.equal(acquisitions.reserve({requestId:id,candidate,episodeIds:[102],nowMs:103}).reason,'release_choice_changed');
  assert.equal(acquisitions.reserve({requestId:id,candidate,episodeIds:[101],preparedHash:'b'.repeat(40),plannedFiles:preview.files,nowMs:103}).reason,'release_choice_changed');
  assert.equal(acquisitions.reserve({requestId:id,candidate,episodeIds:[101],preparedHash:preview.torrentHash,plannedFiles:preview.files,nowMs:103}).state,'reserved');
}));
test('unanswered automatic proposal expires to the registered option across restart', () => fixture(({requests,id,reopen}) => {
  const control = requests.getReleaseControl(id,100);
  const registered={candidate,preview};
  requests.updateReleaseControl(id,control.revision,{mode:'auto',phase:'proposal',expiresMs:200,
    proposal:{registered,better:{candidate:{...candidate,guid:'better'},preview}}},101);
  assert.equal(reopen().getReleaseControl(id,201).selection.candidate.guid,candidate.guid);
}));
