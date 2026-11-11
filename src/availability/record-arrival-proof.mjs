// The direct Plex GUID probe can see a new import before the paged library
// sweep. Save only the proof whose current Shoko file and indexed Plex card
// generations match. Otherwise retain the existing bounded backfill retry.
export function createRecordArrivalProof({ inventory, proofs, cursor,
  now = Date.now } = {}) {
  if (typeof inventory?.getFile !== 'function' ||
      typeof cursor?.confirmRecentFile !== 'function' ||
      typeof cursor?.prioritizeFile !== 'function' ||
      typeof now !== 'function' ||
      (proofs != null && (typeof proofs.observeGuarded !== 'function' ||
        typeof proofs.getCurrent !== 'function'))) {
    throw new TypeError('Invalid arrival proof recorder');
  }
  return (proof, target, outcome) => {
    const observedMs = now();
    const recent = cursor.confirmRecentFile({ fileId: proof.fileId,
      nowMs: observedMs });
    let saved;
    if (proofs && outcome?.cardRevision) {
      try {
        const source = inventory.getFile(proof.fileId);
        if (source?.state === 'linked') {
          saved = proofs.observeGuarded({ anidbId: target.anidbId,
            episodeId: target.episodeId, proof,
            revision: { source: { updated: source.updated,
              observedMs: source.observedMs }, card: outcome.cardRevision },
            checkedMs: observedMs });
        }
      } catch { /* Fall back to the bounded file pass. */ }
    }
    if (recent.state === 'unchanged' &&
        !['recorded', 'stale'].includes(saved?.state) &&
        proofs?.getCurrent(target).state !== 'available') {
      cursor.prioritizeFile({ fileId: proof.fileId, observedMs });
    }
  };
}
