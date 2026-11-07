const held = (reason) => ({ state: 'held', reason });

// A whole provisional pack must be new to Shoko. Check every exact byte
// identity before exposing any of it to the watched Import folder.
export async function checkProvisionalHashesAbsent({ videos,
  readShokoHash } = {}) {
  if (!Array.isArray(videos) || videos.length < 1 || videos.length > 50 ||
      typeof readShokoHash !== 'function') {
    throw new TypeError('Invalid provisional Shoko preflight');
  }
  const seen = new Set();
  for (const file of videos) {
    if (!/^[0-9A-F]{32}$/.test(file?.ed2k) ||
        !Number.isSafeInteger(file.size) || file.size < 1) {
      return held('shoko_preexistence_unverified');
    }
    const key = `${file.ed2k}:${file.size}`;
    if (seen.has(key)) return held('duplicate_provisional_bytes');
    seen.add(key);
    let prior;
    try { prior = await readShokoHash({ ed2k: file.ed2k, size: file.size }); }
    catch { return held('shoko_preexistence_unverified'); }
    if (prior?.state !== 'not_imported') {
      return held(prior?.state?.startsWith('imported_')
        ? 'shoko_file_preexisting' : 'shoko_preexistence_unverified');
    }
  }
  return { state: 'all_absent' };
}
