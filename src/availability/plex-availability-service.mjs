import { readShokoEpisodeFiles } from './shoko-episode-files.mjs';
import { readPlexSectionKeys } from './plex-section-keys.mjs';
import { readPlexItemParts } from './plex-item-parts.mjs';
import { openPlexCardIndex } from './plex-card-index.mjs';
import { createPlexCardPageWorker, indexPlexCardPage,
  retryOnePlexCard } from './plex-card-page-worker.mjs';
import { observeIndexedTarget } from './observe-indexed-target.mjs';
import { observePublicTarget } from './observe-public-target.mjs';
import { readPlexGuidCards } from './plex-guid-cards.mjs';
import { probeFirstTimePublicSections } from
  './probe-first-time-public-sections.mjs';
import { readPlexLibrarySources } from './plex-library-sources.mjs';
import { localPath, validMount } from './known-card-availability.mjs';
import { probePhysicalCandidate } from './physical-plex-part.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const publicResult = (result, includeProof) => includeProof ||
  result?.state !== 'available' ? result :
  { state: 'available', fileId: result.fileId };
const validSections = (sections) => sections &&
  ['episode', 'movie'].every((kind) => Array.isArray(sections[kind]) &&
    sections[kind].length <= 20 && sections[kind].every((id) => validId(id)) &&
    new Set(sections[kind]).size === sections[kind].length) &&
  sections.episode.length + sections.movie.length > 0 &&
  new Set([...sections.episode, ...sections.movie]).size ===
    sections.episode.length + sections.movie.length;

// Isolated read-only composition. It needs explicit public sections and private
// service credentials. Nothing schedules its ticks or exposes it to users yet.
export function createPlexAvailabilityService({ dbPath, shokoBaseUrl,
  shokoApiKey, plexBaseUrl, plexToken, publicSections, shokoMount,
  plexMount, plexMounts, guidProbe = false, sourcePolicy = null,
  fetchImpl = fetch, now = Date.now } = {}) {
  if (!validSections(publicSections) ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof plexBaseUrl !== 'string' || !plexBaseUrl ||
      typeof plexToken !== 'string' || !plexToken ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof guidProbe !== 'boolean' ||
      (sourcePolicy !== null && (!Array.isArray(sourcePolicy) ||
        sourcePolicy.length < 1 || sourcePolicy.length > 4)) ||
      (guidProbe && publicSections.episode.length + publicSections.movie.length > 4)) {
    throw new TypeError('Invalid Plex availability service');
  }
  const index = openPlexCardIndex(dbPath);
  const allowed = ({ libraryId, kind }) =>
    ['episode', 'movie'].includes(kind) && publicSections[kind].includes(libraryId);
  const readCard = (input) => readPlexItemParts({ baseUrl: plexBaseUrl,
    token: plexToken, ...input, fetchImpl });
  const addCandidateKeys = async (card) => {
    if (card?.state !== 'ok' || !Array.isArray(card.parts) ||
        card.parts.length > 40) return card;
    const mounts = (plexMounts ?? (plexMount ? [plexMount] : []))
      .filter(validMount);
    const backingRoots = validMount(shokoMount)
      ? [shokoMount.localRoot] : [];
    const parts = [];
    for (const part of card.parts) {
      if (!validId(part.size)) { parts.push(part); continue; }
      const mapping = mounts.find((mount) => localPath(part.plexPath, mount));
      if (!mapping) { parts.push(part); continue; }
      const filePath = localPath(part.plexPath, mapping);
      let candidate;
      try { candidate = await probePhysicalCandidate({ filePath,
        allowedRoot: mapping.localRoot, backingRoots,
        expectedSize: part.size }); }
      catch { parts.push(part); continue; }
      parts.push(candidate.state === 'candidate'
        ? { ...part, candidateKey: candidate.candidateKey } : part);
    }
    return { ...card, parts };
  };
  const readCardForIndex = async (input) =>
    addCandidateKeys(await readCard(input));
  const readPage = async (input) => {
    const page = await readPlexSectionKeys({ baseUrl: plexBaseUrl,
      token: plexToken, ...input, includeCards: true, fetchImpl });
    if (page.state !== 'page') return page;
    const cards = [];
    for (const card of page.cards) {
      cards.push(card === null ? null : await addCandidateKeys(card));
    }
    return { ...page, cards };
  };
  const readShoko = (input) => readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
    apiKey: shokoApiKey, ...input, purpose: 'availability', fetchImpl });
  return {
    probeFirstTimeSections({ kind } = {}) {
      return probeFirstTimePublicSections({ kind, publicSections,
        readPage: (input) => readPlexSectionKeys({
          baseUrl: plexBaseUrl, token: plexToken, ...input, fetchImpl }),
        ...(sourcePolicy === null ? {} : {
          expectedSources: sourcePolicy,
          readSources: ({ libraryIds }) => readPlexLibrarySources({
            baseUrl: plexBaseUrl, token: plexToken, libraryIds, fetchImpl }),
        }),
      });
    },
    async tick({ libraryId, kind }) {
      if (!allowed({ libraryId, kind })) {
        return { state: 'held', reason: 'library_not_allowed' };
      }
      const worker = createPlexCardPageWorker({ libraryId, kind, index, now,
        readPage, readCard: readCardForIndex });
      const page = await worker.tick();
      const retry = await retryOnePlexCard({ libraryId, kind, index, now,
        readCard: readCardForIndex });
      return retry.state === 'no_due_retry' ? page :
        { ...page, retry: retry.state };
    },
    scanRecent({ libraryId, kind }) {
      if (!allowed({ libraryId, kind })) {
        return Promise.resolve({ state: 'held', reason: 'library_not_allowed' });
      }
      return indexPlexCardPage({ libraryId, kind, offset: 0,
        index, now, readPage, readCard: readCardForIndex });
    },
    // observedShoko is supplied only by the internal presence probe, after its
    // own Shoko read. Never accept this value from a client request body.
    async observeTarget(target, observedShoko, { includeProof = false } = {}) {
      if (!validId(target?.anidbId) || !validId(target.episodeId) ||
          !['series', 'movie'].includes(target.kind)) {
        throw new TypeError('Invalid availability target');
      }
      const publicLibraryIds = target.kind === 'movie'
        ? [...publicSections.episode, ...publicSections.movie]
        : publicSections.episode;
      if (publicLibraryIds.length === 0) {
        return { state: 'unknown', reason: 'public_library_unconfigured' };
      }
      let shoko = observedShoko;
      if (guidProbe) {
        if (!shoko) {
          try { shoko = await readShoko(target); }
          catch { return { state: 'unknown', reason: 'observer_incomplete' }; }
        }
        if (shoko?.state === 'ok' && validId(shoko.shokoEpisodeId) &&
            validId(shoko.shokoSeriesId)) {
          const lookups = publicSections.episode.map((libraryId) => ({
            libraryId, kind: 'episode',
            guid: `tv.plex.agents.custom.shoko://episode/e${shoko.shokoEpisodeId}` }));
          if (target.kind === 'movie' && shoko.tmdbMovieIds?.length === 1 &&
              validId(shoko.tmdbMovieIds[0])) {
            lookups.push(...publicSections.movie.map((libraryId) => ({
              libraryId, kind: 'movie', guid: `tmdb://${shoko.tmdbMovieIds[0]}` })));
          }
          const cards = [];
          for (const lookup of lookups) {
            const found = await readPlexGuidCards({ baseUrl: plexBaseUrl,
              token: plexToken, ...lookup, fetchImpl });
            if (found.state !== 'cards' || found.complete !== true) break;
            cards.push(...found.cards);
            if (cards.length > 10) return { state: 'unknown',
              reason: 'card_discovery_incomplete' };
          }
          if (cards.length > 0) {
            const result = await observePublicTarget({ target, publicLibraryIds,
              knownCards: cards, shokoMount, plexMount, plexMounts,
              readShoko: async () => shoko, readPlex: readCard });
            if (result.state === 'available') {
              return publicResult(result, includeProof);
            }
          }
        }
      }
      const result = await observeIndexedTarget({ target, publicLibraryIds,
        includeProof,
        cardIndex: index, shokoMount, plexMount, plexMounts,
        readShoko: shoko ? async () => shoko : readShoko,
        readPlex: readCard });
      return publicResult(result, includeProof);
    },
    close() { index.close(); },
  };
}
