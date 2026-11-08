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
    const valid = (result) => result?.state === 'details' &&
      result.anidbId === input?.anidbId && result.page === input?.page;
    const safe = (result) => result?.state === 'details' && !valid(result)
      ? { state: 'unavailable' } : result;
    const read = async () => {
      let result;
      try { result = await first(input); }
      catch { /* The other source can still have the catalogue page. */ }
      if (valid(result)) return result;
      return safe(await fallback(input));
    };
    if (deadlineMs === null) return read();
    // A slow archive used to consume the entire first-page deadline before
    // Shoko was tried. Hedge the cached Shoko read after a short delay, while
    // retaining the same overall deadline and exact ID/page validation.
    return new Promise((resolve) => {
      let settled = false;
      let primaryDone = false;
      let secondaryDone = false;
      let primaryResult;
      let secondaryResult;
      let secondaryStarted = false;
      let hedgeTimer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(hedgeTimer);
        resolve(result);
      };
      const finishIfDone = () => {
        if (primaryDone && secondaryDone) {
          finish(secondaryResult ?? primaryResult ?? { state: 'unavailable' });
        }
      };
      const startSecondary = () => {
        if (secondaryStarted || settled) return;
        secondaryStarted = true;
        Promise.resolve().then(() => fallback(input)).catch(() => null)
          .then((result) => {
            secondaryDone = true;
            secondaryResult = safe(result);
            if (valid(result)) finish(result);
            else finishIfDone();
          });
      };
      const deadlineTimer = setTimeout(() => finish(input?.page === 1
        ? { state: 'detail_pending', anidbId: input?.anidbId }
        : { state: 'unavailable' }), deadlineMs);
      deadlineTimer.unref?.();
      hedgeTimer = setTimeout(startSecondary,
        Math.min(750, Math.max(1, Math.floor(deadlineMs / 4))));
      hedgeTimer.unref?.();
      Promise.resolve().then(() => first(input)).catch(() => null)
        .then((result) => {
          primaryDone = true;
          primaryResult = safe(result);
          if (valid(result)) finish(result);
          else { startSecondary(); finishIfDone(); }
        });
    });
  };
}
