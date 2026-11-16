import path from 'node:path';

const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Absence from Plex or an episode is never a failed import. Shoko must show
// the exact accessible file with no series, after its queue settles, twice.
export async function observeShokoUnrecognized({ sourcePath, expectedSize,
  publishedMs, nowMs, prior, readFile, readQueue,
  readUnrecognized } = {}) {
  if (typeof sourcePath !== 'string' ||
      !path.posix.isAbsolute(sourcePath) ||
      path.posix.normalize(sourcePath) !== sourcePath ||
      /[\\\0\r\n]/.test(sourcePath) ||
      !validId(expectedSize) || !validTime(publishedMs) ||
      !validTime(nowMs) || nowMs < publishedMs ||
      typeof readFile !== 'function' || typeof readQueue !== 'function' ||
      typeof readUnrecognized !== 'function') {
    throw new TypeError('Invalid Shoko recognition observation');
  }
  if (nowMs - publishedMs < 300_000) return { state: 'awaiting_shoko' };
  let queue, matches;
  try {
    [queue, matches] = await Promise.all([
      readQueue(), readFile({ sourcePath }),
    ]);
  } catch { return { state: 'shoko_unavailable' }; }
  if (queue?.state === 'unavailable' || !queue?.state ||
      !Array.isArray(matches) || matches.length > 100) {
    return { state: 'shoko_unavailable' };
  }
  if (queue.state !== 'quiet_observed') return { state: 'awaiting_shoko' };
  const exact = matches.filter((item) => item?.Size === expectedSize &&
    validId(item.ID) && Array.isArray(item.Locations) &&
    item.Locations.some((location) =>
      location?.AbsolutePath === sourcePath &&
      location.IsAccessible === true));
  if (exact.length !== 1) return { state: 'awaiting_shoko' };
  const item = exact[0];
  if (!Array.isArray(item.SeriesIDs)) return { state: 'shoko_unavailable' };
  if (item.SeriesIDs.length > 0) return { state: 'recognized',
    fileId: item.ID };
  if (validId(prior?.fileId) && prior.fileId === item.ID &&
      validTime(prior.firstSeenMs) && prior.firstSeenMs >= publishedMs &&
      nowMs - prior.firstSeenMs >= 60_000) {
    let classification;
    try { classification = await readUnrecognized({ fileId: item.ID }); }
    catch { return { state: 'shoko_unavailable' }; }
    if (classification?.state !== 'unrecognized') {
      return classification?.state === 'not_unrecognized'
        ? { state: 'awaiting_shoko' } : { state: 'shoko_unavailable' };
    }
    return { state: 'unrecognized_confirmed', fileId: item.ID };
  }
  return { state: 'unrecognized_pending', fileId: item.ID,
    firstSeenMs: nowMs };
}
