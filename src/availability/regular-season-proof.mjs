// A title-wide positive count may include Specials. Only intersecting exact
// episode IDs with the complete regular-episode catalogue can count a season.
export function countVerifiedRegularEpisodes({ regularIds, verifiedIds }) {
  if (!Array.isArray(regularIds) || !(verifiedIds instanceof Set) ||
      regularIds.some((id) => !Number.isSafeInteger(id) || id < 1)) return null;
  return { verified: regularIds.filter((id) => verifiedIds.has(id)).length,
    total: regularIds.length };
}
