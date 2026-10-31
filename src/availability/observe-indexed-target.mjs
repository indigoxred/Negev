import { observePublicTarget } from './observe-public-target.mjs';

const unknown = (reason) => ({ state: 'unknown', reason });

// The index narrows candidate cards by size only. Every selected card is read
// again and physically compared with the fresh Shoko file before Available.
// An empty or stale index has no negative meaning.
export async function observeIndexedTarget({ target, publicLibraryIds, cardIndex,
  readShoko, readPlex, shokoMount, plexMount, proveImpl } = {}) {
  if (typeof cardIndex?.lookupCards !== 'function' ||
      typeof readShoko !== 'function' || typeof readPlex !== 'function') {
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
  let selected;
  try { selected = cardIndex.lookupCards({
    sizes: [...new Set(shoko.files.map((file) => file.size))],
    libraryIds: publicLibraryIds,
    kind: target.kind === 'movie' ? 'movie' : 'episode',
  }); }
  catch { return unknown('card_discovery_incomplete'); }
  if (selected?.state !== 'candidates' || !Array.isArray(selected.cards) ||
      selected.cards.length === 0) return unknown('card_discovery_incomplete');
  try {
    return await observePublicTarget({ target, publicLibraryIds,
      knownCards: selected.cards, shokoMount, plexMount,
      readShoko: async () => shoko, readPlex, proveImpl });
  } catch { return unknown('observer_incomplete'); }
}
