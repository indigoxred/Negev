const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// A fresh one-card page verifies that each configured public Plex section is
// responsive and still has the expected type. It cannot identify a missing
// anime: Plex's Shoko episode GUID uses a local Shoko ID, not an AniDB ID.
export async function probeFirstTimePublicSections({ kind, publicSections,
  readPage, readSources, expectedSources } = {}) {
  const episodes = publicSections?.episode;
  const movies = publicSections?.movie;
  if (!['series', 'movie'].includes(kind) ||
      !Array.isArray(episodes) || !Array.isArray(movies) ||
      episodes.length + movies.length < 1 ||
      episodes.length + movies.length > 4 ||
      [...episodes, ...movies].some((id) => !validId(id)) ||
      new Set([...episodes, ...movies]).size !== episodes.length + movies.length ||
      typeof readPage !== 'function' ||
      (expectedSources !== undefined &&
        (typeof readSources !== 'function' ||
         !Array.isArray(expectedSources) || expectedSources.length < 1 ||
         expectedSources.length > 4))) {
    throw new TypeError('Invalid first-time Plex section probe');
  }
  const sections = [
    ...episodes.map((libraryId) => ({ libraryId, kind: 'episode' })),
    ...(kind === 'movie'
      ? movies.map((libraryId) => ({ libraryId, kind: 'movie' })) : []),
  ];
  if (sections.length === 0) return held('public_library_unconfigured');
  let sourceVerified = false;
  if (expectedSources !== undefined) {
    let snapshot;
    try {
      snapshot = await readSources({ libraryIds: sections.map((item) =>
        item.libraryId) });
    } catch { return held('public_source_unverified'); }
    if (snapshot?.state !== 'source_snapshot' ||
        !Array.isArray(snapshot.sections) ||
        snapshot.sections.length !== sections.length) {
      return held('public_source_unverified');
    }
    for (const section of sections) {
      const id = section.libraryId;
      const actual = snapshot.sections.filter((item) => item?.libraryId === id);
      const expected = expectedSources.filter((item) => item?.libraryId === id);
      if (actual.length !== 1 || expected.length !== 1 ||
          actual[0].type !== (section.kind === 'episode' ? 'show' : 'movie') ||
          expected[0].type !== actual[0].type ||
          typeof expected[0].agent !== 'string' || !expected[0].agent ||
          expected[0].agent !== actual[0].agent ||
          typeof expected[0].scanner !== 'string' || !expected[0].scanner ||
          expected[0].scanner !== actual[0].scanner ||
          !Array.isArray(actual[0].roots) ||
          !Array.isArray(expected[0].roots) ||
          actual[0].roots.length < 1 ||
          actual[0].roots.length !== expected[0].roots.length ||
          new Set(actual[0].roots).size !== actual[0].roots.length ||
          new Set(expected[0].roots).size !== expected[0].roots.length ||
          JSON.stringify([...actual[0].roots].sort()) !==
            JSON.stringify([...expected[0].roots].sort())) {
        return held('public_source_unverified');
      }
    }
    sourceVerified = true;
  }
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
    parts: [], complete: false, probeCoverage: 'health_only',
    sourceVerified };
}
