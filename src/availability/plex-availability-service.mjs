import { readShokoEpisodeFiles } from './shoko-episode-files.mjs';
import { readPlexSectionKeys } from './plex-section-keys.mjs';
import { readPlexItemParts } from './plex-item-parts.mjs';
import { openPlexCardIndex } from './plex-card-index.mjs';
import { createPlexCardPageWorker } from './plex-card-page-worker.mjs';
import { observeIndexedTarget } from './observe-indexed-target.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
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
  plexMount, plexMounts, fetchImpl = fetch, now = Date.now } = {}) {
  if (!validSections(publicSections) ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof plexBaseUrl !== 'string' || !plexBaseUrl ||
      typeof plexToken !== 'string' || !plexToken ||
      typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid Plex availability service');
  }
  const index = openPlexCardIndex(dbPath);
  return {
    tick({ libraryId, kind }) {
      if (!['episode', 'movie'].includes(kind) ||
          !publicSections[kind].includes(libraryId)) {
        return Promise.resolve({ state: 'held', reason: 'library_not_allowed' });
      }
      const worker = createPlexCardPageWorker({ libraryId, kind, index, now,
        readPage: (input) => readPlexSectionKeys({ baseUrl: plexBaseUrl,
          token: plexToken, ...input, fetchImpl }),
        readCard: (input) => readPlexItemParts({ baseUrl: plexBaseUrl,
          token: plexToken, ...input, fetchImpl }) });
      return worker.tick();
    },
    observeTarget(target) {
      if (!validId(target?.anidbId) || !validId(target.episodeId) ||
          !['series', 'movie'].includes(target.kind)) {
        throw new TypeError('Invalid availability target');
      }
      const publicLibraryIds = target.kind === 'movie'
        ? publicSections.movie : publicSections.episode;
      if (publicLibraryIds.length === 0) {
        return Promise.resolve({ state: 'unknown', reason: 'public_library_unconfigured' });
      }
      return observeIndexedTarget({ target, publicLibraryIds,
        cardIndex: index, shokoMount, plexMount, plexMounts,
        readShoko: (input) => readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, ...input, fetchImpl }),
        readPlex: (input) => readPlexItemParts({ baseUrl: plexBaseUrl,
          token: plexToken, ...input, fetchImpl }) });
    },
    close() { index.close(); },
  };
}
