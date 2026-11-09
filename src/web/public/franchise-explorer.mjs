const validId = (id) => Number.isSafeInteger(id) && id > 0;
const relationGroups = [
  ['prequel', 'Prequels'], ['sequel', 'Sequels'],
  ['mainstory', 'Main stories'], ['sidestory', 'Side stories'],
  ['alternative', 'Alternatives'], ['alternativeversion', 'Alternate versions'],
];

// Relations found through another installment describe that hop, not a direct
// relationship to the title being viewed. Keep those cards in a separate group.
export function groupFranchiseItems(items, rootId) {
  if (!Array.isArray(items) || !validId(rootId)) {
    throw new TypeError('Invalid franchise group input');
  }
  const direct = new Map(relationGroups.map(([key]) => [key, []]));
  const other = [];
  const indirect = [];
  for (const item of items) {
    if (item?.anidbId === rootId) continue;
    if (item?.relatedFrom !== rootId) { indirect.push(item); continue; }
    const key = item.relation?.replace(/[_\s-]/g, '').toLowerCase();
    (direct.get(key) ?? other).push(item);
  }
  return [
    ...relationGroups.filter(([key]) => direct.get(key).length > 0)
      .map(([key, heading]) => ({ heading, items: direct.get(key) })),
    ...(other.length ? [{ heading: 'Other relations', items: other }] : []),
    ...(indirect.length ? [{ heading: 'More linked titles', items: indirect }] : []),
  ];
}

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
        relation: item.relation.trim(), relatedFrom: result.anidbId,
        ...(item.libraryPresence ? { libraryPresence: item.libraryPresence } : {}) });
      expanded.add(result.anidbId);
    },
  };
}

// One user action may need several one-hop reads to show a useful group of
// installments. Bound the walk so a large or cyclic franchise stays cheap.
export async function expandFranchiseBatch({ explorer, read, maxReads = 8,
  minNewItems = 8, shouldContinue = () => true } = {}) {
  if (typeof explorer?.next !== 'function' ||
      typeof explorer?.items !== 'function' ||
      typeof explorer?.add !== 'function' ||
      typeof explorer?.skip !== 'function' || typeof read !== 'function' ||
      typeof shouldContinue !== 'function' ||
      !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 12 ||
      !Number.isSafeInteger(minNewItems) || minNewItems < 1 || minNewItems > 49) {
    throw new TypeError('Invalid franchise expansion');
  }
  const before = explorer.items().length;
  let reads = 0;
  let failures = 0;
  while (reads < maxReads && explorer.items().length - before < minNewItems &&
      shouldContinue()) {
    const next = explorer.next();
    if (!next) break;
    reads++;
    let response;
    try { response = await read(next.anidbId); }
    catch (error) {
      // Only a definite missing response can rule out this branch. Access,
      // throttling, server, and transport failures leave it retryable.
      if (![404, 410].includes(error?.status)) {
        return { state: error?.status === 429 ? 'rate_limited' :
          'temporarily_unavailable', reads,
          added: explorer.items().length - before,
          failures: failures + 1, hasMore: true };
      }
      if (next.anidbId === explorer.items()[0].anidbId) {
        return { state: 'root_unavailable', reads, added: 0,
          failures: 1, hasMore: true };
      }
      explorer.skip(next.anidbId);
      failures++;
      continue;
    }
    if (response?.state === 'unavailable') {
      return { state: 'temporarily_unavailable', reads,
        added: explorer.items().length - before,
        failures: failures + 1, hasMore: true };
    }
    try { explorer.add(response); }
    catch {
      if (next.anidbId === explorer.items()[0].anidbId) {
        return { state: 'root_unavailable', reads, added: 0,
          failures: 1, hasMore: true };
      }
      explorer.skip(next.anidbId);
      failures++;
    }
  }
  return { state: shouldContinue() ? 'expanded' : 'cancelled',
    reads, added: explorer.items().length - before, failures,
    hasMore: explorer.next() !== null };
}
