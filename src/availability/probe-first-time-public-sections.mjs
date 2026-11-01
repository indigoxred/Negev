const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// A fresh one-card page verifies that each configured public Plex section is
// responsive and still has the expected type. It cannot identify a missing
// anime: Plex's Shoko episode GUID uses a local Shoko ID, not an AniDB ID.
export async function probeFirstTimePublicSections({ kind, publicSections,
  readPage } = {}) {
  const episodes = publicSections?.episode;
  const movies = publicSections?.movie;
  if (!['series', 'movie'].includes(kind) ||
      !Array.isArray(episodes) || !Array.isArray(movies) ||
      episodes.length + movies.length < 1 ||
      episodes.length + movies.length > 4 ||
      [...episodes, ...movies].some((id) => !validId(id)) ||
      new Set([...episodes, ...movies]).size !== episodes.length + movies.length ||
      typeof readPage !== 'function') {
    throw new TypeError('Invalid first-time Plex section probe');
  }
  const sections = [
    ...episodes.map((libraryId) => ({ libraryId, kind: 'episode' })),
    ...(kind === 'movie'
      ? movies.map((libraryId) => ({ libraryId, kind: 'movie' })) : []),
  ];
  if (sections.length === 0) return held('public_library_unconfigured');
  for (const section of sections) {
    let result;
    try { result = await readPage({ ...section, offset: 0, pageSize: 1 }); }
    catch { return held('public_probe_unavailable'); }
    if (result?.state !== 'page' || result.libraryId !== section.libraryId ||
        result.kind !== section.kind || result.offset !== 0 ||
        result.complete !== false ||
        !Number.isSafeInteger(result.totalSize) || result.totalSize < 0 ||
        !Array.isArray(result.keys) || result.keys.length > 1 ||
        result.keys.some((key) => !validId(key)) ||
        result.keys.length > result.totalSize) {
      return held('public_probe_unavailable');
    }
  }
  return { state: 'healthy_unconfirmed',
    libraryIds: sections.map((section) => section.libraryId),
    parts: [], complete: false, probeCoverage: 'health_only' };
}
