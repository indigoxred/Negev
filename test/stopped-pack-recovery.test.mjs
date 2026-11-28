import test from 'node:test';
import assert from 'node:assert/strict';
import { stoppedPack } from './helpers/stopped-pack.mjs';

for (const priorityFailure of ['before', 'after']) test(`stopped season resumes once when exclusion acknowledgement fails ${priorityFailure} application`, async t => {
  const x = await stoppedPack(t, { priorityFailure });
  const first = await x.submit();
  assert.equal(x.state.adds, 1);
  if (priorityFailure === 'before') assert.equal(first.state, 'held');
  else assert.equal(first.state, 'stopped_observed');
  x.reopen();
  const result = await x.start();
  assert.equal(result.state, 'start_unknown', JSON.stringify(result));
  assert.equal(x.state.adds, 1, 'recovery must never add the same torrent twice');
  assert.equal(x.state.starts, 1);
  assert.deepEqual(x.files.map(file => file.priority), [0, 1]);
  await x.start();
  assert.equal(x.state.starts, 1, 'the durable start receipt must prevent replay');
  assert.equal(x.state.priorities, priorityFailure === 'before' ? 2 : 1);
});

test('selection is journaled before the add and survives a component reopen', async t => {
  const x = await stoppedPack(t);
  await x.submit();
  x.reopen();
  const selection = x.ledger.getTorrentSelection?.(x.attemptId);
  assert.deepEqual(selection?.files, x.files.map(file => ({ name: file.name, size: file.size })));
  assert.deepEqual(selection?.excludedFileNames, [x.files[0].name]);
  assert.equal(selection?.torrentHash, x.hash);
});

test('an older stranded stopped pack recovers from its exact exported descriptor', async t => {
  const x = await stoppedPack(t);
  await x.submit(); x.dropSelection(); x.reopen();
  const result = await x.start();
  assert.equal(result.state, 'start_unknown', JSON.stringify(result));
  assert.equal(x.state.exports, 1);
  assert.equal(x.state.adds, 1);
  assert.equal(x.state.starts, 1);
  assert.deepEqual(x.files.map(file => file.priority), [0, 1]);
});

test('legacy selection recovery cannot trust different exported torrent bytes', async t => {
  const x = await stoppedPack(t);
  await x.submit(); x.dropSelection(); x.reopen(); x.state.corruptExport = true;
  const writes = x.state.priorities;
  assert.equal((await x.start()).state, 'held');
  assert.equal(x.state.exports, 1);
  assert.equal(x.state.priorities, writes);
  assert.equal(x.state.starts, 0);
});

for (const change of ['size', 'name', 'owner', 'access', 'mount']) test(`stopped selection recovery refuses changed ${change}`, async t => {
  const x = await stoppedPack(t);
  await x.submit(); x.reopen();
  if (change === 'size') x.files[0].size++;
  if (change === 'name') x.files[0].name = 'Foreign - 01.mkv';
  if (change === 'owner') x.torrent.category = 'foreign';
  if (change === 'access') x.state.ownerAllowed = false;
  if (change === 'mount') x.state.mountReady = false;
  const writes = x.state.priorities;
  assert.equal((await x.start()).state, 'held');
  assert.equal(x.state.priorities, writes, 'unverified ownership/manifest cannot authorize a priority write');
  assert.equal(x.state.starts, 0);
});
