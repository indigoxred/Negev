// Shoko can lack relation metadata for an unowned title while the AniDB
// archive already has it. Accept only resolved AniDB titles in that fallback;
// a numeric placeholder cannot protect against a neighboring installment.
export async function readRelatedEvidence({ anidbId, readLocal, readArchive } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      typeof readLocal !== 'function' || typeof readArchive !== 'function') {
    throw new TypeError('Invalid relation evidence reader');
  }
  let local;
  try { local = await readLocal(); } catch { local = { state: 'unavailable' }; }
  if (local?.state === 'related_titles' && local.anidbId === anidbId) return local;
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
  return archive;
}
