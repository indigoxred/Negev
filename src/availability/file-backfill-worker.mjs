import { createHash } from 'node:crypto';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const load = () => ({ cardReads: 0, physicalProbes: 0 });
const fingerprint = (candidate) => createHash('sha256').update(JSON.stringify([
  candidate.fileId, candidate.updated, candidate.size,
  candidate.anidbFileId, candidate.releaseEvidence,
  candidate.pairs, candidate.identities, candidate.sourcePaths,
])).digest('hex');

// Source-only, one Shoko file per tick. A fresh exact observation is a
// proposal; only the proof ledger's atomic source-generation guard may save it.
export function createFileBackfillWorker({ cursor, inventory, readCandidate,
  resolveKind, observeCandidate, proofs, now = Date.now,
  maxPairChecks = 10 } = {}) {
  if (typeof cursor?.claim !== 'function' ||
      typeof cursor.record !== 'function' ||
      typeof inventory?.listFileHintIds !== 'function' ||
      typeof inventory.getFile !== 'function' ||
      [readCandidate, resolveKind, observeCandidate, now].some((fn) =>
        typeof fn !== 'function') ||
      typeof proofs?.observeGuarded !== 'function' ||
      !Number.isSafeInteger(maxPairChecks) ||
      maxPairChecks < 1 || maxPairChecks > 10) {
    throw new TypeError('Invalid file backfill worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return { state: 'held', reason: 'file_backfill_busy' };
      busy = true;
      try {
        const claim = cursor.claim({ inventory, nowMs: now(), limit: 1 });
        if (claim.state !== 'claimed') return claim;
        const fileId = claim.fileIds[0];
        const budget = load();
        const finish = (outcome, checkedPairs, available) => {
          const saved = cursor.record({ claim, outcomes: [{ fileId,
            ...outcome }], nowMs: now() });
          if (!['recorded', 'partial'].includes(saved.state)) return saved;
          return { state: saved.state === 'partial' ? 'partial' : 'checked',
            checkedPairs, available, load: { ...budget } };
        };
        let source, candidate;
        try {
          source = inventory.getFile(fileId);
          candidate = await readCandidate({ fileId });
        } catch { return finish({ state: 'unknown' }, 0, 0); }
        if (candidate?.state === 'busy') {
          return { state: 'held', reason: 'metadata_busy' };
        }
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
            catch { kind = null; }
            if (kind?.state === 'busy') {
              return { state: 'held', reason: 'metadata_busy' };
            }
            kinds.set(pair.anidbId, kind);
          }
          const kind = kinds.get(pair.anidbId);
          if (!['series', 'movie'].includes(kind)) continue;
          let outcome;
          try { outcome = await observeCandidate({ candidate,
            target: { ...pair, kind }, budget }); }
          catch { continue; }
          if (outcome?.state === 'busy') {
            return { state: 'held', reason: 'metadata_busy' };
          }
          if (outcome?.reason === 'read_budget_exhausted') {
            if (index === start) {
              return finish({ state: 'held' }, 1, 0);
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
        try { confirmed = await readCandidate({ fileId }); }
        catch { confirmed = null; }
        if (confirmed?.state === 'busy') {
          return { state: 'held', reason: 'metadata_busy' };
        }
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
          if (saved.state === 'recorded' || saved.state === 'stale') available++;
        }
        if (end < candidate.pairs.length) {
          return finish({ state: 'partial', nextPairOffset: end,
            fingerprint: identity }, end - start, available);
        }
        return finish({ state: available ? 'available' : 'unknown' },
          end - start, available);
      } finally { busy = false; }
    },
  };
}
