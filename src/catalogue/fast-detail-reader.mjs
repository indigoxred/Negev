// Prefer exact AniDB episode IDs from the public snapshot for a first-time
// title. Shoko remains the fallback and the sole authority for imported files.
export function createFastDetailReader({ archive, shoko, prefer = 'archive',
  deadlineMs = null }) {
  if (typeof archive !== 'function' || typeof shoko !== 'function' ||
      !['archive', 'shoko'].includes(prefer) ||
      deadlineMs !== null && (!Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 || deadlineMs > 10_000)) {
    throw new TypeError('Invalid fast detail reader');
  }
  const first = prefer === 'archive' ? archive : shoko;
  const fallback = prefer === 'archive' ? shoko : archive;
  return async (input) => {
    const read = async () => {
      let result;
      try { result = await first(input); }
      catch { /* The other source can still have the catalogue page. */ }
      if (result?.state === 'details' && result.anidbId === input?.anidbId &&
          result.page === input?.page) return result;
      return fallback(input);
    };
    if (deadlineMs === null) return read();
    let timer;
    try {
      return await Promise.race([read(), new Promise((resolve) => {
        timer = setTimeout(() => resolve(input?.page === 1
          ? { state: 'detail_pending', anidbId: input?.anidbId }
          : { state: 'unavailable' }), deadlineMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  };
}
