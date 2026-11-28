import test from 'node:test';
import assert from 'node:assert/strict';
import { stoppedPack } from './helpers/stopped-pack.mjs';
import { openStartQueue } from '../src/acquisition/start-queue.mjs';
import { listOperationalReview } from '../src/acquisition/operational-review.mjs';
import { runPrestartMismatchRetirement } from '../src/acquisition/run-prestart-mismatch-retirement.mjs';
import { deletePrestartMismatchTorrent } from '../src/acquisition/delete-prestart-mismatch-torrent.mjs';
import { retirePrestartMismatchAbsent } from '../src/acquisition/retire-prestart-mismatch-absent.mjs';

for (const obstruction of ['none', 'provider', 'mount', 'bytes', 'torrent']) test(`uncertain removal remains actionable across restart and checks ${obstruction}`, async t => {
  const x = await stoppedPack(t, { selected: [1, 2], priorityFailure: 'none' });
  await x.submit();
  x.torrent.content_path = x.torrent.save_path + '/Example';
  const queue = openStartQueue(x.dbPath, { acquisitions: x.ledger });
  try {
    const claim = queue.claimNext({ nowMs: x.state.clock });
    queue.recordResult({ ...claim, state: 'held', reason: 'related_installment_mismatch', checkedMs: x.state.clock });
  } finally { queue.close(); }
  let deletes = 0, failingObservation = true;
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith('/delete')) { deletes++; x.state.added = false; return new Response(''); }
    if (!x.state.added && failingObservation) return new Response(null, { status: 503 });
    return x.fetchImpl(url, init);
  };
  const lstatImpl = async () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); };
  const config = { ledger: x.ledger, attemptId: x.attemptId, hash: x.hash, baseUrl: 'http://qbit.invalid/',
    stagingRoot: '/staging', saveRoot: x.saveRoot, verifyStagingRoot: x.verifyStagingRoot,
    sessionGate: { get: async () => ({ state: 'authenticated', sessionId: 'syntheticSID' }) }, now: () => x.state.clock };
  const first = await runPrestartMismatchRetirement({ ...config,
    deleteImpl: input => deletePrestartMismatchTorrent({ ...input, fetchImpl, lstatImpl }),
    reconcileImpl: input => retirePrestartMismatchAbsent({ ...input, fetchImpl, lstatImpl }) });
  assert.equal(first.state, 'held'); assert.equal(deletes, 1, JSON.stringify(first));
  x.reopen();
  const empty = { listReviewNeeded: () => [] };
  const review = () => listOperationalReview({ acquisitions: x.ledger, startQueue: empty, completionQueue: empty, publishQueue: empty });
  assert.deepEqual(review().items, [{ attemptId: x.attemptId, requestId: x.requestId, anidbId: 42,
    stage: 'removal_hold', reason: 'removal_unconfirmed', observedMs: x.state.clock }]);
  assert.ok(!JSON.stringify(review()).includes(x.hash));
  const { reconcilePendingRemoval } = await import('../src/acquisition/reconcile-pending-removal.mjs');
  failingObservation = obstruction === 'provider';
  x.state.mountReady = obstruction !== 'mount';
  x.state.added = obstruction === 'torrent';
  const result = await reconcilePendingRemoval({ ...config, ledger: x.ledger, fetchImpl,
    lstatImpl: obstruction === 'bytes' ? async () => ({ isDirectory: () => false, isSymbolicLink: () => false }) : lstatImpl });
  if (obstruction === 'none') {
    assert.equal(result.state, 'retired_prestart_mismatch', JSON.stringify(result));
    assert.deepEqual(review().items, []);
  } else { assert.equal(result.state, 'held'); assert.equal(review().items.length, 1); }
  assert.equal(deletes, 1, 'a recheck must never send a second delete');
});

test('an uncertain started removal rechecks without repeating the delete', async t => {
  const x = await stoppedPack(t, { selected: [1, 2], priorityFailure: 'none' });
  await x.submit(); await x.start();
  assert.equal(x.ledger.requestStalledRetirement({attemptId:x.attemptId,hash:x.hash,nowMs:x.state.clock}).state,'retirement_requested');
  assert.equal(x.ledger.beginStalledDelete({attemptId:x.attemptId,hash:x.hash,nowMs:x.state.clock}).sendNow,true);
  x.state.added=false; x.reopen();
  const { reconcilePendingRemoval } = await import('../src/acquisition/reconcile-pending-removal.mjs');
  let writes=0;
  const result=await reconcilePendingRemoval({ledger:x.ledger,attemptId:x.attemptId,baseUrl:'http://qbit.invalid/',
    stagingRoot:'/staging',verifyStagingRoot:x.verifyStagingRoot,now:()=>x.state.clock,
    sessionGate:{get:async()=>({state:'authenticated',sessionId:'syntheticSID'})},
    fetchImpl:async(url,init)=>{if(init.method!=='GET')writes++;return x.fetchImpl(url,init);},
    lstatImpl:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});} });
  assert.equal(result.state,'retired_stalled',JSON.stringify(result)); assert.equal(writes,0);
  assert.deepEqual(x.ledger.listPendingRemovalReview(),[]);
});
