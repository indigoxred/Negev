import { createHash } from 'node:crypto';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const load = () => ({ cardReads: 0, physicalProbes: 0 });
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
// Shoko link and location arrays are sets. Keep both the saved pair offset
// and the before/after identity check stable if their response order changes.
const canonicalCandidate = (candidate) => candidate?.state !== 'candidate'
  ? candidate : { ...candidate,
    pairs: Array.isArray(candidate.pairs) ? [...candidate.pairs].sort((a, b) =>
      a.anidbId - b.anidbId || a.episodeId - b.episodeId) : candidate.pairs,
    identities: Array.isArray(candidate.identities)
      ? candidate.identities.map((identity) => ({ ...identity,
        tmdbMovieIds: Array.isArray(identity.tmdbMovieIds)
          ? [...identity.tmdbMovieIds].sort((a, b) => a - b)
          : identity.tmdbMovieIds })).sort((a, b) =>
        compareText(JSON.stringify(a), JSON.stringify(b)))
      : candidate.identities,
    sourcePaths: Array.isArray(candidate.sourcePaths)
      ? [...candidate.sourcePaths].sort() : candidate.sourcePaths };
const fingerprint = (candidate) => createHash('sha256').update(JSON.stringify([
  candidate.fileId, candidate.updated, candidate.size,
  candidate.anidbFileId, candidate.releaseEvidence,
  candidate.pairs, candidate.identities, candidate.sourcePaths,
])).digest('hex');

// Source-only, bounded Shoko files per tick. A fresh exact observation is a
// proposal; only the proof ledger's atomic source-generation guard may save it.
export function createFileBackfillWorker({ cursor, inventory, readCandidate,
  resolveKind, observeCandidate, proofs, now = Date.now,
  maxPairChecks = 10, maxFilesPerTick = 1 } = {}) {
  if (typeof cursor?.claim !== 'function' ||
      typeof cursor.record !== 'function' ||
      typeof inventory?.listFileHintIds !== 'function' ||
      typeof inventory.getFile !== 'function' ||
      [readCandidate, resolveKind, observeCandidate, now].some((fn) =>
        typeof fn !== 'function') ||
      typeof proofs?.observeGuarded !== 'function' ||
      !Number.isSafeInteger(maxPairChecks) ||
      maxPairChecks < 1 || maxPairChecks > 10 ||
      !Number.isSafeInteger(maxFilesPerTick) ||
      maxFilesPerTick < 1 || maxFilesPerTick > 10) {
    throw new TypeError('Invalid file backfill worker');
  }
  let busy = false;
  let failedReceipt = null;
  let readFailures = 0;
  const processOne = async (budget, seen) => {
    const claim = cursor.claim({ inventory, nowMs: now(), limit: 1 });
    if (claim.state !== 'claimed') return claim;
    const fileId = claim.fileIds[0];
    if (seen.has(fileId)) return { state: 'pass_repeated' };
    seen.add(fileId);
    const finish = (outcome, checkedPairs, available, reason) => {
      const saved = cursor.record({ claim, outcomes: [{ fileId,
        ...outcome }], nowMs: now() });
      if (!['recorded', 'partial'].includes(saved.state)) return saved;
      failedReceipt = null;
      readFailures = 0;
      return { state: saved.state === 'partial' ? 'partial' : 'checked',
        ...(reason ? { reason } : {}),
        checkedPairs, available, load: { ...budget } };
    };
    const claimExpired = () => {
      const ageMs = now() - claim.claimedMs;
      return Number.isSafeInteger(ageMs) && ageMs >= 15 * 60_000;
    };
    const metadataBusy = () => claimExpired()
      ? finish({ state: 'held' }, 0, 0, 'metadata_busy_deferred')
      : { state: 'held', reason: 'metadata_busy' };
    const sourceReadFailed = () => {
      const receipt = `${claim.pass}:${claim.receipt}`;
      if (failedReceipt !== receipt) {
        failedReceipt = receipt;
        readFailures = 0;
      }
      // The cursor survives restart while this retry counter does not.
      // Age the saved claim out so repeated restarts cannot pin the pass.
      if (claimExpired()) {
        return finish({ state: 'unknown' }, 0, 0);
      }
      if (++readFailures === 1) {
        return { state: 'held', reason: 'source_read_unavailable' };
      }
      return finish({ state: 'unknown' }, 0, 0);
    };
    let source, candidate;
    try {
      source = inventory.getFile(fileId);
      candidate = canonicalCandidate(await readCandidate({ fileId }));
    } catch { return sourceReadFailed(); }
    if (candidate?.state === 'busy') {
      return metadataBusy();
    }
    if (candidate?.state === 'unavailable') return sourceReadFailed();
    if (source?.state !== 'linked' || !validTime(source.observedMs) ||
        candidate?.state !== 'candidate' || candidate.fileId !== fileId ||
        candidate.updated !== source.updated || !validId(candidate.size) ||
        !Array.isArray(candidate.pairs) || candidate.pairs.length < 1 ||
        candidate.pairs.length > 100 || candidate.pairs.some((pair) =>
          !validId(pair?.anidbId) || !validId(pair.episodeId))) {
      return finish({ state: 'unknown' }, 0, 0);
    }
    const identity = fingerprint(candidate);
    const start = claim.fingerprint === identity ? claim.pairOffset : 0;
    if (start >= candidate.pairs.length) {
      return finish({ state: 'unknown' }, 0, 0);
    }
    let end = Math.min(candidate.pairs.length, start + maxPairChecks);
    const proposals = [];
    const kinds = new Map();
    for (let index = start; index < end; index++) {
      if (budget.cardReads >= 10 || budget.physicalProbes >= 64) {
        end = index;
        break;
      }
      const pair = candidate.pairs[index];
      if (!kinds.has(pair.anidbId)) {
        let kind;
        try { kind = await resolveKind({ anidbId: pair.anidbId }); }
        catch { return sourceReadFailed(); }
        if (kind?.state === 'busy') {
          return metadataBusy();
        }
        if (kind?.state === 'unavailable') return sourceReadFailed();
        kinds.set(pair.anidbId, kind);
      }
      const kind = kinds.get(pair.anidbId);
      if (!['series', 'movie'].includes(kind)) continue;
      let outcome;
      try { outcome = await observeCandidate({ candidate,
        target: { ...pair, kind }, budget }); }
      catch { return sourceReadFailed(); }
      if (outcome?.state === 'busy') {
        return metadataBusy();
      }
      if (outcome?.reason === 'observer_incomplete') {
        return sourceReadFailed();
      }
      if (outcome?.reason === 'read_budget_exhausted') {
        if (index === start) {
          // Defer this pathological file to the next pass so it cannot
          // hold every later file, but report that no pair was checked.
          return finish({ state: 'held' }, 0, 0, 'read_budget_exhausted');
        }
        end = index;
        break;
      }
      if (outcome?.state === 'available' &&
          outcome?.proof?.fileId === fileId &&
          outcome?.fileId === fileId && outcome.cardRevision) {
        proposals.push({ ...pair, proof: outcome.proof,
          cardRevision: outcome.cardRevision });
      }
    }
    if (budget.cardReads > 10 || budget.physicalProbes > 64) {
      return { state: 'held', reason: 'file_backfill_budget_exceeded' };
    }
    let confirmed;
    try { confirmed = canonicalCandidate(await readCandidate({ fileId })); }
    catch { return sourceReadFailed(); }
    if (confirmed?.state === 'busy') {
      return metadataBusy();
    }
    if (confirmed?.state === 'unavailable') return sourceReadFailed();
    if (confirmed?.state !== 'candidate' ||
        fingerprint(confirmed) !== identity) {
      return finish({ state: 'unknown' }, end - start, 0);
    }
    let available = 0;
    for (const proposal of proposals) {
      let saved;
      try {
        saved = proofs.observeGuarded({ anidbId: proposal.anidbId,
          episodeId: proposal.episodeId, proof: proposal.proof,
          revision: { source: { updated: source.updated,
            observedMs: source.observedMs },
          card: proposal.cardRevision }, checkedMs: now() });
      } catch { return { state: 'held', reason: 'proof_write_unavailable' }; }
      if (!['recorded', 'stale'].includes(saved?.state)) {
        return sourceReadFailed();
      }
      if (saved.state === 'recorded') available++;
    }
    if (end < candidate.pairs.length) {
      return finish({ state: 'partial', nextPairOffset: end,
        fingerprint: identity }, end - start, available);
    }
    return finish({ state: available ? 'available' : 'unknown' },
      end - start, available);
  };
  return {
    async runOnce() {
      if (busy) return { state: 'held', reason: 'file_backfill_busy' };
      busy = true;
      try {
        const budget = load();
        const seen = new Set();
        let checkedFiles = 0;
        let deferredFiles = 0;
        let checkedPairs = 0;
        let available = 0;
        for (let index = 0; index < maxFilesPerTick; index++) {
          if (budget.cardReads >= 10 || budget.physicalProbes >= 64) break;
          const result = await processOne(budget, seen);
          if (maxFilesPerTick === 1) return result;
          if (result.state === 'checked') {
            if (['read_budget_exhausted', 'metadata_busy_deferred']
              .includes(result.reason)) deferredFiles++;
            else checkedFiles++;
            checkedPairs += result.checkedPairs;
            available += result.available;
            continue;
          }
          if (result.state === 'idle' || result.state === 'pass_repeated') break;
          if (result.state === 'partial') {
            return { ...result, checkedFiles,
              ...(deferredFiles ? { deferredFiles } : {}),
              checkedPairs: checkedPairs + result.checkedPairs,
              available: available + result.available, load: { ...budget } };
          }
          return checkedFiles || checkedPairs || deferredFiles
            ? { ...result, checkedFiles,
              ...(deferredFiles ? { deferredFiles } : {}),
              checkedPairs, available, load: { ...budget } }
            : result;
        }
        return checkedFiles || checkedPairs || seen.size
          ? { state: 'checked', checkedFiles,
            ...(deferredFiles ? { deferredFiles } : {}), checkedPairs, available,
            load: { ...budget } }
          : { state: 'idle' };
      } finally { busy = false; }
    },
  };
}
