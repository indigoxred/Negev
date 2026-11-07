import path from 'node:path';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

function exactUnrecognized(plan, file) {
  return file?.state === 'imported_unrecognized' &&
    file.fileId === plan.fileId && file.ed2k === plan.ed2k &&
    file.size === plan.size && Array.isArray(file.locations) &&
    file.locations.some((location) => validId(location?.managedFolderId) &&
      location.accessible === true && location.path === plan.ownedPath);
}

function exactRelease(plan, release) {
  const refs = release?.crossReferences;
  return release?.isCorrupted === false && Array.isArray(refs) &&
    refs.length === 1 && refs[0]?.animeId === plan.anidbId &&
    refs[0]?.episodeId === plan.episodeId && refs[0]?.start === 0 &&
    refs[0]?.end === 100;
}

// Source-only, opt-in Shoko User-link operation. Shoko's supported save API
// has no compare-and-swap; re-read and post-check narrow but cannot eliminate
// the race with an independent Shoko match. This is not wired into runtime.
export async function commitProvisionalShokoLink({ plan, readImportedFile,
  previewRelease, saveRelease, now = () => new Date() } = {}) {
  if (plan?.state !== 'link_ready' || !validId(plan.fileId) ||
      !validId(plan.anidbId) || !validId(plan.episodeId) ||
      !/^[0-9A-F]{32}$/.test(plan.ed2k) || !validId(plan.size) ||
      typeof plan.ownedPath !== 'string' ||
      !path.posix.isAbsolute(plan.ownedPath) ||
      path.posix.normalize(plan.ownedPath) !== plan.ownedPath ||
      /[\0\r\n\\]/.test(plan.ownedPath) ||
      typeof readImportedFile !== 'function' ||
      typeof previewRelease !== 'function' ||
      typeof saveRelease !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid provisional Shoko link operation');
  }
  const read = () => readImportedFile({ ed2k: plan.ed2k,
    size: plan.size, includeAbsolutePaths: true });
  let first;
  try { first = await read(); }
  catch { return held('shoko_unavailable'); }
  if (!exactUnrecognized(plan, first)) return held('shoko_file_changed');
  let preview;
  try { preview = await previewRelease(plan.fileId); }
  catch { return held('shoko_preview_unavailable'); }
  if (preview?.state === 'match') {
    return held(exactRelease(plan, preview.release)
      ? 'shoko_native_match_pending' : 'shoko_identity_conflict');
  }
  if (preview?.state !== 'no_match') return held('shoko_preview_unavailable');
  let second;
  try { second = await read(); }
  catch { return held('shoko_unavailable'); }
  if (!exactUnrecognized(plan, second)) return held('shoko_file_changed');

  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
    throw new TypeError('Invalid Shoko link timestamp');
  }
  const body = { ProviderName: 'User', Version: 1, FileSize: plan.size,
    IsCorrupted: false, IsDeprecated: false, Source: 'Unknown',
    CrossReferences: [{ AnidbAnimeID: plan.anidbId,
      AnidbEpisodeID: plan.episodeId, PercentageStart: 0,
      PercentageEnd: 100 }], Updated: timestamp.toISOString(),
    Created: timestamp.toISOString(), PreventRescan: false,
    DeferToNext: false };
  let saved;
  try { saved = await saveRelease(plan.fileId, body); }
  catch { return held('shoko_link_save_failed'); }
  if (saved?.state !== 'saved') return held('shoko_link_save_failed');
  let after;
  try { after = await read(); }
  catch { return held('shoko_link_unverified'); }
  if (after?.state !== 'imported_recognized' ||
      after.fileId !== plan.fileId || after.ed2k !== plan.ed2k ||
      after.size !== plan.size || !exactRelease(plan, after.release)) {
    return held('shoko_link_unverified');
  }
  return { state: 'shoko_link_verified', fileId: plan.fileId };
}
