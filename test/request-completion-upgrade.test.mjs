import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';
import { requestPresentation } from '../src/web/public/request-progress-text.mjs';
import { createRequestCompletionReader } from '../src/requests/request-completion-history.mjs';

async function fixture(t, { expanded = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-completion-upgrade-'));
  const file = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(await readFile(new URL('./fixtures/airing-finale-v0.0.322.sql', import.meta.url), 'utf8'));
  if (!expanded) db.exec('DELETE FROM request_targets WHERE target_id=2');
  const acquisitions = openAcquisitionLedger(file);
  const moves = openPureMoveLedger(file);
  let progress = openRequestProgress(file, { pureMode: true });
  t.after(async () => {
    progress.close(); moves.close(); acquisitions.close(); db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, file, read: () => progress.read(1), reopen: () => {
    progress.close(); progress = openRequestProgress(file, { pureMode: true });
  } };
}

test('disabled acquisition preserves exact v322 completion before queue migration and restart without writes', async t => {
  const x = await fixture(t);
  const before = x.db.prepare('SELECT * FROM acquisition_request_checks').all();
  const version = x.db.prepare('PRAGMA schema_version').get();
  const dataVersion = x.db.prepare('PRAGMA data_version').get();
  x.db.exec('PRAGMA query_only=ON');
  for (let i = 0; i < 2; i++) {
    const progress = x.read();
    assert.equal(progress.oneTimeAcquisitionComplete, true);
    assert.equal(progress.publicAvailability, 'unverified');
    assert.equal(requestPresentation(progress, 'series', { monitorFuture: true, watchClosed: true }).group, 'completed');
    x.reopen();
  }
  assert.deepEqual(x.db.prepare('SELECT * FROM acquisition_request_checks').all(), before);
  assert.deepEqual(x.db.prepare('PRAGMA schema_version').get(), version);
  assert.deepEqual(x.db.prepare('PRAGMA data_version').get(), dataVersion);
  assert.equal(x.db.prepare('PRAGMA table_info(acquisition_request_checks)').all().some(c => c.name === 'scan_targets_json'), false);
});

test('progress switches to modern exact evidence after the queue initializes late', async t => {
  const x = await fixture(t);
  assert.equal(x.read().oneTimeAcquisitionComplete, true);
  const queue = openAcquisitionRequestQueue(x.file);
  try {
    assert.equal(x.read().oneTimeAcquisitionComplete, true);
    // A missing modern snapshot must not silently fall back to the legacy hash.
    x.db.exec('UPDATE acquisition_request_checks SET scan_targets_json=NULL');
    assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
    x.reopen();
    assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
  } finally { queue.close(); }
});

for (const control of ['expanded', 'unknown', 'wrong_hash', 'wrong_episode', 'wrong_anime', 'manual_subset', 'open_watch', 'wrong_reason', 'unfinished']) {
  test(`legacy history rejects ${control} completion evidence before and after restart`, async t => {
    const x = await fixture(t, { expanded: control === 'expanded' || control === 'manual_subset' });
    if (control === 'unknown') x.db.exec('UPDATE acquisition_request_checks SET scan_scope=NULL');
    if (control === 'wrong_hash') x.db.prepare('UPDATE acquisition_request_checks SET scan_scope=?').run('f'.repeat(64));
    if (control === 'wrong_episode') x.db.exec('UPDATE targets SET episode_id=1003 WHERE id=1');
    if (control === 'wrong_anime') x.db.exec('UPDATE targets SET anidb_id=43 WHERE id=1');
    if (control === 'manual_subset') {
      // The selected episode is fulfilled, but the full durable request has two targets.
      x.db.exec(`UPDATE requests SET release_control='{"mode":"auto","phase":"consumed","revision":2,"selection":{"preview":{"episodeIds":[1001]}}}'`);
    }
    if (control === 'open_watch') x.db.exec('UPDATE requests SET watch_closed=0');
    if (control === 'wrong_reason') x.db.exec("UPDATE acquisition_request_checks SET reason='no_safe_release'");
    if (control === 'unfinished') x.db.exec('UPDATE acquisition_request_checks SET state=NULL');
    assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
    x.reopen();
    assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
  });
}

test('legacy exact completion becomes unsettled when a finale target is appended on the same reader', async t => {
  const x = await fixture(t);
  assert.equal(x.read().oneTimeAcquisitionComplete, true);
  x.db.exec('INSERT INTO request_targets VALUES (1,2)');
  assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
  x.reopen();
  assert.notEqual(x.read().oneTimeAcquisitionComplete, true);
});

for (const revision of [null, 0, 1, 2]) for (const phase of ['chosen', 'consumed']) {
  test(`legacy matching full hash with ${phase} subset follows scope policy revision ${revision}`, async t => {
    const x = await fixture(t, { expanded: true });
    x.db.exec(`UPDATE acquisition_request_checks SET scan_scope='a04a67f3f0ad63048c2f58089c3678f018324b8d1933c8a959b8ae65648f7d7c',scan_target_count=2`);
    if (revision === null) x.db.exec('ALTER TABLE acquisition_request_checks DROP COLUMN request_scope_policy_revision');
    else x.db.prepare('UPDATE acquisition_request_checks SET request_scope_policy_revision=?').run(revision);
    x.db.prepare('UPDATE requests SET release_control=?').run(JSON.stringify({
      mode: phase === 'chosen' ? 'manual' : 'auto', phase, revision: 2,
      selection: { preview: { episodeIds: [1001] } },
    }));
    const read = createRequestCompletionReader(x.db);
    assert.equal(read(1), revision === 2);
  });
}
