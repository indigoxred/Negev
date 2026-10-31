import { observeKnownCardAvailability } from './known-card-availability.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const unknown = (reason) => ({ state: 'unknown', reason });

// A bounded positive join for cards discovered by a separate, scoped Plex
// observer. A selected card is never negative proof of the rest of a library.
// A caller must not use this result to authorize a missing-target acquisition.
export async function observePublicTarget({ target, publicLibraryIds, knownCards,
  shokoMount, plexMount, readShoko, readPlex, proveImpl } = {}) {
  if (!validId(target?.anidbId) || !validId(target.episodeId) ||
      !['series', 'movie'].includes(target.kind) ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      publicLibraryIds.length > 20 || publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      !Array.isArray(knownCards) || knownCards.length > 10 ||
      typeof readShoko !== 'function' || typeof readPlex !== 'function') {
    throw new TypeError('Invalid public target observation');
  }
  const publicIds = new Set(publicLibraryIds);
  const selected = new Set();
  for (const card of knownCards) {
    const key = `${card?.libraryId}:${card?.ratingKey}`;
    if (!publicIds.has(card?.libraryId) || !validId(card.ratingKey) ||
        selected.has(key)) throw new TypeError('Invalid scoped Plex card');
    selected.add(key);
  }
  if (knownCards.length === 0) return unknown('card_discovery_incomplete');
  let shoko;
  try { shoko = await readShoko({ anidbId: target.anidbId,
    episodeId: target.episodeId }); }
  catch { return unknown('observer_incomplete'); }
  if (shoko?.state !== 'ok' || !Array.isArray(shoko.files) ||
      shoko.files.length === 0) return unknown('observer_incomplete');
  const parts = [];
  let incomplete = false;
  for (const card of knownCards) {
    let result;
    try { result = await readPlex({ libraryId: card.libraryId,
      ratingKey: card.ratingKey,
      expectedType: target.kind === 'movie' ? 'movie' : 'episode' }); }
    catch { incomplete = true; continue; }
    if (result?.state !== 'ok' || result.complete !== true ||
        !Array.isArray(result.parts) || result.parts.length > 40 ||
        result.parts.some((part) => part?.libraryId !== card.libraryId)) {
      incomplete = true;
      continue;
    }
    parts.push(...result.parts);
  }
  const result = await observeKnownCardAvailability({ target, shoko,
    plex: { state: 'ok', complete: true, parts }, publicLibraryIds,
    shokoMount, plexMount, ...(proveImpl ? { proveImpl } : {}) });
  if (result.state === 'available') return result;
  if (incomplete) return unknown('observer_incomplete');
  if (result.state === 'held') return result;
  return unknown('card_discovery_incomplete');
}
