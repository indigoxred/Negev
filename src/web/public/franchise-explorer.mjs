const validId = (id) => Number.isSafeInteger(id) && id > 0;

// A bounded, opt-in walk of Shoko's verified outgoing relations. The result
// never claims that the AniDB franchise is complete or joins request targets.
export function createFranchiseExplorer(seed, maxItems = 50) {
  if (!validId(seed?.anidbId) || typeof seed.title !== 'string' ||
      !seed.title.trim() || !Number.isSafeInteger(maxItems) ||
      maxItems < 1 || maxItems > 50) throw new TypeError('Invalid franchise seed');
  const members = new Map([[seed.anidbId, { anidbId: seed.anidbId,
    title: seed.title.trim(), relation: null }]]);
  const expanded = new Set();
  return {
    items: () => [...members.values()],
    next: () => [...members.values()].find((item) => !expanded.has(item.anidbId)) ?? null,
    status: () => ({ state: expanded.size === 0 ? 'not_checked' :
      members.size === 1 ? 'no_cached_links' : 'linked_installments',
    linkedInstallments: members.size - 1 }),
    skip(anidbId) {
      if (!validId(anidbId) || !members.has(anidbId) || expanded.has(anidbId)) {
        throw new TypeError('Invalid franchise installment');
      }
      expanded.add(anidbId);
    },
    add(result) {
      if (result?.state !== 'related_titles' ||
          result.completeness !== 'unproven' ||
          !members.has(result.anidbId) || expanded.has(result.anidbId) ||
          !Array.isArray(result.items) || result.items.length > 50) {
        throw new TypeError('Invalid franchise relations');
      }
      const seen = new Set();
      for (const item of result.items) {
        if (!validId(item?.anidbId) || item.anidbId === result.anidbId ||
            seen.has(item.anidbId) || typeof item.title !== 'string' ||
            !item.title.trim() || typeof item.relation !== 'string' ||
            !item.relation.trim() ||
            (item.libraryPresence !== undefined &&
              (!['in_library', 'unknown'].includes(item.libraryPresence?.state) ||
                !Number.isSafeInteger(item.libraryPresence.verifiedEpisodeCount) ||
                item.libraryPresence.verifiedEpisodeCount < 0 ||
                item.libraryPresence.verifiedEpisodeCount > 10_000 ||
                (item.libraryPresence.state === 'in_library') !==
                  (item.libraryPresence.verifiedEpisodeCount > 0)))) {
          throw new TypeError('Invalid franchise installment');
        }
        seen.add(item.anidbId);
      }
      const newItems = result.items.filter((item) => !members.has(item.anidbId));
      if (members.size + newItems.length > maxItems) {
        throw new RangeError('Franchise view reached its safety limit');
      }
      for (const item of newItems) members.set(item.anidbId, {
        anidbId: item.anidbId, title: item.title.trim(),
        relation: item.relation.trim(),
        ...(item.libraryPresence ? { libraryPresence: item.libraryPresence } : {}) });
      expanded.add(result.anidbId);
    },
  };
}
