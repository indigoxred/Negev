import { observePublicTarget } from './observe-public-target.mjs';
import { localPath, validMount } from './known-card-availability.mjs';
import { probePhysicalCandidate } from './physical-plex-part.mjs';

const unknown = (reason) => ({ state: 'unknown', reason });

// The index narrows candidate cards by physical identity when available, then
// by size for legacy observations. Every selected card is read
// again and physically compared with the fresh Shoko file before Available.
// An empty or stale index has no negative meaning.
export async function observeIndexedTarget({ target, publicLibraryIds, cardIndex,
  readShoko, readPlex, shokoMount, plexMount, plexMounts, proveImpl,
  probeImpl = probePhysicalCandidate, now = Date.now } = {}) {
  if (typeof cardIndex?.lookupCards !== 'function' ||
      typeof readShoko !== 'function' || typeof readPlex !== 'function' ||
      typeof probeImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid indexed availability observer');
  }
  let shoko;
  try { shoko = await readShoko({ anidbId: target?.anidbId,
    episodeId: target?.episodeId }); }
  catch { return unknown('observer_incomplete'); }
  if (shoko?.state !== 'ok' || !Array.isArray(shoko.files) ||
      shoko.files.length === 0 || shoko.files.length > 50 ||
      shoko.files.some((file) => !Number.isSafeInteger(file?.size) ||
        file.size < 1)) return unknown('observer_incomplete');
  const keys = new Set();
  if (typeof cardIndex.lookupCardsByCandidateKey === 'function' &&
      validMount(shokoMount)) {
    let checks = 0;
    for (const file of shoko.files) {
      if (!Array.isArray(file.sourcePaths) || file.sourcePaths.length > 20) {
        return unknown('observer_incomplete');
      }
      for (const remote of file.sourcePaths) {
        if (++checks > 64) return unknown('card_discovery_incomplete');
        const filePath = localPath(remote, shokoMount);
        if (!filePath) return unknown('card_discovery_incomplete');
        let candidate;
        try { candidate = await probeImpl({ filePath,
          allowedRoot: shokoMount.localRoot, expectedSize: file.size }); }
        catch { continue; }
        if (candidate?.state === 'candidate' &&
            typeof candidate.candidateKey === 'string') {
          keys.add(candidate.candidateKey);
        }
      }
    }
  }
  let cards = [];
  try {
    for (const kind of target.kind === 'movie' ? ['episode', 'movie'] : ['episode']) {
      let selected;
      if (keys.size > 0 && typeof cardIndex.lookupCardsByCandidateKey === 'function') {
        selected = cardIndex.lookupCardsByCandidateKey({ keys: [...keys],
          libraryIds: publicLibraryIds, kind });
        if (selected?.state !== 'candidates' || !Array.isArray(selected.cards)) {
          return unknown('card_discovery_incomplete');
        }
      }
      if (!selected || selected.cards.length === 0) {
        selected = cardIndex.lookupCards({
          sizes: [...new Set(shoko.files.map((file) => file.size))],
          libraryIds: publicLibraryIds, kind,
        });
      }
      if (selected?.state !== 'candidates' || !Array.isArray(selected.cards)) {
        return unknown('card_discovery_incomplete');
      }
      cards.push(...selected.cards.map((card) => ({ ...card, kind })));
      if (cards.length > 10) return unknown('card_discovery_incomplete');
    }
  }
  catch { return unknown('card_discovery_incomplete'); }
  if (cards.length === 0) return unknown('card_discovery_incomplete');
  try {
    return await observePublicTarget({ target, publicLibraryIds,
      knownCards: cards, shokoMount, plexMount, plexMounts,
      readShoko: async () => shoko,
      readPlex: async (input) => {
        const result = await readPlex(input);
        if (['not_found', 'no_parts'].includes(result?.state) &&
            typeof cardIndex.forgetCard === 'function') {
          try {
            const observedMs = now();
            if (Number.isSafeInteger(observedMs) && observedMs >= 0) {
              cardIndex.forgetCard({ libraryId: input.libraryId,
                ratingKey: input.ratingKey, observedMs });
            }
          } catch { /* A stale index cannot become absence evidence. */ }
        }
        return result;
      }, proveImpl });
  } catch { return unknown('observer_incomplete'); }
}
