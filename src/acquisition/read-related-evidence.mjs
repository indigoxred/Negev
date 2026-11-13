// Shoko can lack relation metadata for an unowned title while the AniDB
// archive already has it. Accept only resolved AniDB titles in that fallback;
// a numeric placeholder cannot protect against a neighboring installment.
export async function readRelatedEvidence({ anidbId, readLocal, readArchive,
  aliasesForId } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      typeof readLocal !== 'function' || typeof readArchive !== 'function' ||
      (aliasesForId !== undefined && typeof aliasesForId !== 'function')) {
    throw new TypeError('Invalid relation evidence reader');
  }
  const withAliases = (result) => {
    if (!aliasesForId || result.state !== 'related_titles') return result;
    try {
      const items = result.items.map((item) => {
        const aliases = aliasesForId(item.anidbId);
        if (!Array.isArray(aliases) || aliases.length > 20 ||
            aliases.some((alias) => typeof alias !== 'string' ||
              alias.length < 2 || alias.length > 120 ||
              /[\x00-\x1f\x7f]/.test(alias))) {
          throw new TypeError('Invalid related-title aliases');
        }
        return { ...item, aliases: [...new Set(aliases)]
          .filter((alias) => alias !== item.title) };
      });
      return { ...result, items };
    } catch { return { state: 'unavailable' }; }
  };
  let local;
  try { local = await readLocal(); } catch { local = { state: 'unavailable' }; }
  if (local?.state === 'related_titles' && local.anidbId === anidbId) {
    return withAliases(local);
  }
  let archive;
  try { archive = await readArchive(); } catch { return { state: 'unavailable' }; }
  if (archive?.state !== 'related_titles' || archive.anidbId !== anidbId ||
      !Array.isArray(archive.items) || archive.items.length > 50 ||
      archive.items.some((item) =>
        !Number.isSafeInteger(item?.anidbId) || item.anidbId < 1 ||
        typeof item.title !== 'string' || !item.title.trim() ||
        item.title === `AniDB ${item.anidbId}`)) {
    return { state: 'unavailable' };
  }
  return withAliases(archive);
}
