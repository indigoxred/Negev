const validId = (value) => Number.isSafeInteger(value) && value > 0;
const FAMILY_TYPES = new Set(['SameSetting', 'AlternativeSetting',
  'AlternativeVersion', 'Prequel', 'Sequel', 'MainStory', 'SideStory',
  'FullStory', 'Summary']);
const NON_FAMILY_TYPES = new Set(['Other', 'SharedCharacters']);
const held = (reason) => ({ state: 'held', reason });

// Assemble only from supplied, verified AniDB relation rows. Shoko's
// per-title endpoint returns outgoing links, so even a closed graph cannot
// prove that no incoming-only installment exists elsewhere in its cache.
// Every member remains its own requestable installment.
export function assembleAniDbFranchise({ seedId, relationRows,
  maxMembers = 50 } = {}) {
  if (!validId(seedId) || !Array.isArray(relationRows) ||
      relationRows.length > 200 || !Number.isSafeInteger(maxMembers) ||
      maxMembers < 1 || maxMembers > 100) {
    throw new TypeError('Invalid franchise graph input');
  }
  const rows = new Map();
  for (const row of relationRows) {
    if (!validId(row?.anidbId) || rows.has(row.anidbId) ||
        row.state !== 'relations' || !Array.isArray(row.items) ||
        row.items.length > 200) return held('invalid_relation_row');
    const seen = new Set();
    for (const item of row.items) {
      if (!validId(item?.relatedId) || item.relatedId === row.anidbId ||
          seen.has(item.relatedId) || typeof item.verified !== 'boolean' ||
          !(FAMILY_TYPES.has(item.type) || NON_FAMILY_TYPES.has(item.type))) {
        return held('invalid_relation_row');
      }
      seen.add(item.relatedId);
    }
    rows.set(row.anidbId, row.items);
  }
  const members = new Set([seedId]);
  const queue = [seedId];
  const frontier = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    const edges = rows.get(id);
    if (!edges) { frontier.add(id); continue; }
    for (const edge of edges) {
      if (!FAMILY_TYPES.has(edge.type)) continue;
      if (!edge.verified) return held('unverified_relation');
      // Shoko's per-title AniDB endpoint supplies outgoing edges only. AniDB
      // can store a verified one-way relation without a reverse row, so the
      // absence of a reverse edge is not contradictory evidence.
      if (!members.has(edge.relatedId)) {
        members.add(edge.relatedId);
        if (members.size > maxMembers) return held('franchise_budget_exceeded');
        queue.push(edge.relatedId);
      }
    }
  }
  if (frontier.size) return { state: 'pending',
    reason: 'relation_rows_missing', frontier: [...frontier].sort((a, b) => a - b) };
  return { state: 'related_installments', completeness: 'unproven', seedId,
    installmentIds: [...members].sort((a, b) => a - b) };
}
