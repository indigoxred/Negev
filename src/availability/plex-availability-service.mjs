import { readShokoEpisodeFiles } from './shoko-episode-files.mjs';
import { readPlexSectionKeys } from './plex-section-keys.mjs';
import { readPlexItemParts } from './plex-item-parts.mjs';
import { openPlexCardIndex } from './plex-card-index.mjs';
import { createPlexCardPageWorker, indexPlexCardPage,
  retryOnePlexCard } from './plex-card-page-worker.mjs';
import { observeIndexedTarget } from './observe-indexed-target.mjs';
import { observeFileCandidateTarget } from './observe-file-candidate-target.mjs';
import { observePublicTarget } from './observe-public-target.mjs';
import { readPlexGuidCards } from './plex-guid-cards.mjs';
import { probeFirstTimePublicSections } from
  './probe-first-time-public-sections.mjs';
import { readPlexLibrarySources } from './plex-library-sources.mjs';
import { localPath, validMount } from './known-card-availability.mjs';
import { probePhysicalCandidate } from './physical-plex-part.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const changedCard = () => ({ state: 'unknown',
  reason: 'card_changed_during_observation' });
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
  const addCandidateKeys = async (card, load) => {
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
      try {
        if (load) load.candidateProbes++;
        candidate = await probePhysicalCandidate({ filePath,
        allowedRoot: mapping.localRoot, backingRoots,
        expectedSize: part.size }); }
      catch { parts.push(part); continue; }
      parts.push(candidate.state === 'candidate'
        ? { ...part, candidateKey: candidate.candidateKey } : part);
    }
    return { ...card, parts };
  };
  const readCardForIndex = async (input, load) => {
    if (load) load.exactCardReads++;
    return addCandidateKeys(await readCard(input), load);
  };
  const readPage = async (input, load) => {
    if (load) load.sectionPages++;
    const page = await readPlexSectionKeys({ baseUrl: plexBaseUrl,
      token: plexToken, ...input, includeCards: true, fetchImpl });
    if (page.state !== 'page') return page;
    const cards = [];
    for (const card of page.cards) {
      cards.push(card === null ? null : await addCandidateKeys(card, load));
    }
    return { ...page, cards };
  };
  const indexReaders = (load) => ({
    readPage: (input) => readPage(input, load),
    readCard: (input) => readCardForIndex(input, load),
  });
  const loadSnapshot = (load, started) => ({ ...load,
    elapsedMs: Math.max(0, Math.ceil(performance.now() - started)) });
  const readShoko = (input) => readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
    apiKey: shokoApiKey, ...input, purpose: 'availability', fetchImpl });
  const indexProvenGuidCard = async (result, target, shoko) => {
    const proof = result?.proof;
    if (result?.state !== 'available' || !validId(proof?.libraryId) ||
        !validId(proof.ratingKey) || !validId(proof.partId) ||
        typeof proof.storageKey !== 'string') return changedCard();
    const kind = publicSections.movie.includes(proof.libraryId)
      ? 'movie' : 'episode';
    try {
      const card = await readCardForIndex({ libraryId: proof.libraryId,
        ratingKey: proof.ratingKey, expectedType: kind });
      if (card?.state !== 'ok' || card.complete !== true ||
          !card.parts.some((part) => part.partId === proof.partId &&
            part.candidateKey === proof.storageKey)) return changedCard();
      const rechecked = await observePublicTarget({ target,
        publicLibraryIds: [proof.libraryId],
        knownCards: [{ libraryId: proof.libraryId,
          ratingKey: proof.ratingKey, kind }],
        shokoMount, plexMount, plexMounts,
        readShoko: async () => shoko, readPlex: async () => card });
      if (rechecked.state !== 'available' ||
          rechecked.proof?.fileId !== proof.fileId ||
          rechecked.proof?.partId !== proof.partId ||
          rechecked.proof?.storageKey !== proof.storageKey) return changedCard();
      index.recordCard({ libraryId: proof.libraryId,
        ratingKey: proof.ratingKey, kind, parts: card.parts,
        observedMs: now() });
      const cardRevision = index.getCardRevision({ libraryId: proof.libraryId,
        ratingKey: proof.ratingKey });
      return cardRevision ? { ...result, cardRevision } : changedCard();
    } catch { return changedCard(); }
  };
  return {
    // Internal file-centric path: the caller must obtain this candidate from
    // a fresh Shoko file read. The exact Plex card and physical part are still
    // rechecked before returning proof.
    observeFileCandidate({ candidate, target, budget } = {}) {
      const shared = budget ?? { cardReads: 0, physicalProbes: 0 };
      if (!Number.isSafeInteger(shared.cardReads) || shared.cardReads < 0 ||
          shared.cardReads > 10 ||
          !Number.isSafeInteger(shared.physicalProbes) ||
          shared.physicalProbes < 0 || shared.physicalProbes > 64) {
        throw new TypeError('Invalid file availability read budget');
      }
      if (shared.cardReads === 10 || shared.physicalProbes === 64) {
        return { state: 'unknown', reason: 'read_budget_exhausted' };
      }
      const readBudgetedCard = (input) => {
        if (shared.cardReads >= 10) throw new Error('Card read budget exhausted');
        shared.cardReads++;
        return readCard(input);
      };
      const probeBudgeted = (input) => {
        if (shared.physicalProbes >= 64) {
          throw new Error('Physical probe budget exhausted');
        }
        shared.physicalProbes++;
        return probePhysicalCandidate(input);
      };
      const publicLibraryIds = target?.kind === 'movie'
        ? [...publicSections.episode, ...publicSections.movie]
        : publicSections.episode;
      return observeFileCandidateTarget({ candidate, target,
        publicLibraryIds, cardIndex: index, readPlex: readBudgetedCard,
        probeImpl: probeBudgeted, shokoMount, plexMount, plexMounts, now });
    },
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
    async tick({ libraryId, kind, includeLoad = false }) {
      if (!allowed({ libraryId, kind })) {
        return { state: 'held', reason: 'library_not_allowed' };
      }
      const started = performance.now();
      const load = { sectionPages: 0, exactCardReads: 0,
        candidateProbes: 0 };
      const readers = indexReaders(load);
      const worker = createPlexCardPageWorker({ libraryId, kind, index, now,
        ...readers });
      const page = await worker.tick();
      // A changing addedAt page can invalidate every full sweep. Recheck one
      // older indexed card directly instead of treating a page omission as
      // proof of removal; the existing retry worker enforces the read cap.
      index.scheduleOldestCardRecheck({ libraryId, kind, nowMs: now() });
      const retry = await retryOnePlexCard({ libraryId, kind, index, now,
        readCard: readers.readCard });
      const result = retry.state === 'no_due_retry' ? page :
        { ...page, retry: retry.state };
      return includeLoad ? { ...result, load: loadSnapshot(load, started) } :
        result;
    },
    async scanRecent({ libraryId, kind, includeLoad = false }) {
      if (!allowed({ libraryId, kind })) {
        return { state: 'held', reason: 'library_not_allowed' };
      }
      const started = performance.now();
      const load = { sectionPages: 0, exactCardReads: 0,
        candidateProbes: 0 };
      const result = await indexPlexCardPage({ libraryId, kind, offset: 0,
        index, now, ...indexReaders(load) });
      return includeLoad ? { ...result, load: loadSnapshot(load, started) } :
        result;
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
              return publicResult(includeProof
                ? await indexProvenGuidCard(result, target, shoko) : result,
              includeProof);
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
