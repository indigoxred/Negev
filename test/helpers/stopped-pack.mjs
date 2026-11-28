import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../../src/acquisition/acquisition-ledger.mjs';
import { buildStoppedTorrentAddForm } from '../../src/acquisition/qbittorrent-add-form.mjs';
import { submitStoppedCandidate } from '../../src/acquisition/submit-stopped-candidate.mjs';
import { processRecordedStart } from '../../src/acquisition/process-recorded-start.mjs';
import { DatabaseSync } from 'node:sqlite';

export function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort()
    .flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')]);
}

export async function stoppedPack(t, { count = 2, selected = [2], priorityFailure = 'before',
  reserve = true, evidencePolicy = 'strict' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-stopped-pack-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const ids = Array.from({ length: count }, (_, i) => 1001 + i);
  const saved = requests.submit({ requesterId: 1, requestKey: 'season', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false, episodeIds: ids } });
  let ledger = openAcquisitionLedger(dbPath);
  const files = ids.map((id, index) => ({ index, name: `Example - ${String(index + 1).padStart(2, '0')}.mkv`,
    size: 100, priority: 1, progress: 0 }));
  const info = { name: 'Example', files: files.map(file => ({ length: file.size, path: [file.name] })),
    'piece length': 16384, pieces: Buffer.alloc(20, 97) };
  const bytes = encode({ info }), hash = createHash('sha1').update(encode(info)).digest('hex');
  const saveRoot = '/Downloads/negev', savePath = `${saveRoot}/${hash}`;
  const candidate = { indexerId: 7, guid: 'season-pack',
    title: `Example 01-${String(count).padStart(2, '0')} 1080p`, size: count * 100, seeders: 10, evidence: 'unverified' };
  const selectedFiles = files.filter(file => selected.includes(file.index + 1))
    .map(file => ({ name: file.name, size: file.size, episodeIds: [ids[file.index]] }));
  let attemptId = null;
  if (reserve) {
    attemptId = ledger.reserve({ requestId: saved.requestId, candidate,
      episodeIds: selectedFiles.flatMap(file => file.episodeIds), evidencePolicy, nowMs: 200 }).attemptId;
    ledger.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    ledger.recordFilePlan({ attemptId, hash, plannedFiles: selectedFiles, nowMs: 202 });
  }
  const state = { clock: 300, added: false, adds: 0, starts: 0, priorities: 0,
    ownerAllowed: true, mountReady: true, exports: 0, exportStatus: 200, corruptExport: false };
  const torrent = { hash, category: 'negev', save_path: savePath, state: 'stoppedDL',
    progress: 0, downloaded: 0, amount_left: count * 100, auto_tmm: false, force_start: false };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/version')) return new Response('v5.3.0');
    if (endpoint.endsWith('/export')) {
      state.exports++;
      if (state.exportStatus !== 200) return new Response(null, { status: state.exportStatus });
      return new Response(state.corruptExport ? encode({ info: { ...info, pieces: Buffer.alloc(20, 98) } }) : bytes);
    }
    if (endpoint.endsWith('/add')) { state.adds++; state.added = true; return new Response('Ok.'); }
    if (endpoint.endsWith('/filePrio')) {
      state.priorities++;
      if (state.priorities === 1 && priorityFailure === 'before') throw Error('priority write not applied');
      const body = new URLSearchParams(init.body);
      for (const index of body.get('id').split('|').map(Number)) files[index].priority = Number(body.get('priority'));
      if (state.priorities === 1 && priorityFailure === 'after') throw Error('priority acknowledgement lost');
      return new Response('');
    }
    if (endpoint.endsWith('/start')) { state.starts++; return new Response(''); }
    if (endpoint.endsWith('/info')) return Response.json(state.added ? [torrent] : []);
    if (endpoint.endsWith('/properties')) return Response.json({ save_path: savePath, download_path: '' });
    if (endpoint.endsWith('/files')) return Response.json(files);
    throw Error(`Unexpected endpoint ${endpoint}`);
  };
  const authorizeRequest = async () => state.ownerAllowed
    ? { state: 'authorized', restricted: false } : { state: 'held', reason: 'account_access_changed' };
  const evidence = async ({ episodeIds }) => ({ anidbId: 42, episodeIds, observedAtMs: state.clock,
    shoko: { state: 'ok', complete: true, files: [] },
    plex: { state: 'ok', complete: true, sourceVerified: true, libraryIds: [102], parts: [] },
    importFence: { state: 'settled', anidbId: 42, episodeIds,
      beforeObservedAtMs: state.clock, afterObservedAtMs: state.clock } });
  const verifyStagingRoot = async () => state.mountReady
    ? { state: 'verified_staging_root' } : { state: 'held', reason: 'staging_root_unverified' };
  const prepared = { state: 'prepared_stopped', expected: { hash, category: 'negev', savePath },
    files: files.map(file => ({ name: file.name, size: file.size })), version: 'v1', totalBytes: count * 100,
    form: buildStoppedTorrentAddForm({ torrentBytes: bytes, savePath, category: 'negev' }) };
  t.after(async () => { ledger.close(); requests.close(); await rm(root, { recursive: true, force: true }); });
  const context = { root, dbPath, requests, ids, files, selectedFiles, state, torrent, hash,
    bytes, candidate, prepared, fetchImpl, authorizeRequest, verifyStagingRoot, saveRoot,
    requestId: saved.requestId,
    get attemptId() { return attemptId; },
    useAttempt(id) { attemptId = id; },
    get ledger() { return ledger; },
    reopen() { ledger.close(); ledger = openAcquisitionLedger(dbPath); },
    dropSelection() {
      const db = new DatabaseSync(dbPath);
      try { db.prepare('DELETE FROM acquisition_torrent_selections WHERE attempt_id=?').run(attemptId); }
      finally { db.close(); }
    },
    submit: () => submitStoppedCandidate({ ledger, attemptId, candidate, prepared,
      hostPath: '/staging', saveRoot, baseUrl: 'http://qbit.invalid/', sessionId: 'syntheticSID',
      verifyStagingRoot, fetchImpl, authorizeRequest, nowMs: state.clock,
      plannedFileNames: selectedFiles.map(file => file.name),
      excludedFileNames: files.filter(file => !selected.includes(file.index + 1)).map(file => file.name) }),
    start: overrides => processRecordedStart({ attemptId, requests, acquisitions: ledger,
      stagingHostPath: '/staging', qbitStagingRoot: saveRoot,
      qbittorrent: { baseUrl: 'http://qbit.invalid/', sessionId: 'syntheticSID' },
      verifyStagingRoot, fetchImpl, authorizeRequest, readEvidence: evidence,
      publicLibraryIds: [102], now: () => state.clock, ...overrides }),
  };
  return context;
}
