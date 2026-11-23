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
import { openAvailabilityScope } from './availability-scope.mjs';
import { readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const changedCard = () => ({ state: 'unknown',
  reason: 'card_changed_during_observation' });
const publicResult = (result, includeProof) => includeProof ||
  result?.state !== 'available' ? result :
  { state: 'available', fileId: result.fileId,
    ...(result.multipart === true ? { multipart: true } : {}) };
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
  fetchImpl = fetch, now = Date.now, enforceScope = false } = {}) {
  if (!validSections(publicSections) ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof plexBaseUrl !== 'string' || !plexBaseUrl ||
      typeof plexToken !== 'string' || !plexToken ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof guidProbe !== 'boolean' || typeof enforceScope !== 'boolean' ||
      (sourcePolicy !== null && (!Array.isArray(sourcePolicy) ||
        sourcePolicy.length < 1 || sourcePolicy.length > 4)) ||
      (guidProbe && publicSections.episode.length + publicSections.movie.length > 4)) {
    throw new TypeError('Invalid Plex availability service');
  }
  const index = openPlexCardIndex(dbPath);
  const scope = enforceScope ? openAvailabilityScope(dbPath) : null;
  let trustedUntil = -1, retryAfter = 0, scopeRead, closed = false, scopeGeneration = null;
  const scopeAbort = new AbortController();
  const isScopeCurrent = () => !closed && (!enforceScope || (now() >= 0 && now() < trustedUntil));
  const ensureScope = () => {
    if (closed) return Promise.resolve({state:'held',reason:'public_scope_unverified'});
    if (isScopeCurrent()) return Promise.resolve({state:'ready'});
    if (scopeRead) return scopeRead;
    if (now() < retryAfter) return Promise.resolve({state:'held',reason:'public_scope_unverified'});
    scopeRead = (async()=>{
      try {
        const url = new URL('/identity',plexBaseUrl);
        const response = await fetchImpl(url,{method:'GET',redirect:'manual',
          headers:{'X-Plex-Token':plexToken,Accept:'application/json'},
          signal:AbortSignal.any([scopeAbort.signal,AbortSignal.timeout(10000)])});
        const body=response.status===200 ? await readBoundedJson(response,100000) : null;
        const machine=body?.MediaContainer?.machineIdentifier;
        if (closed) throw new Error('Observer closed');
        if(typeof machine!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(machine)) throw new Error('Missing Plex server identity');
        const endpoint = value => { const u=new URL(value); return u.origin+u.pathname; };
        const reconciled=scope.reconcile({serverIdentity:JSON.stringify([machine,endpoint(plexBaseUrl),endpoint(shokoBaseUrl)]),
          episodeLibraryIds:publicSections.episode,movieLibraryIds:publicSections.movie,
          shokoMount,plexMounts:plexMounts ?? (plexMount?[plexMount]:[]),observedMs:now()});
        scopeGeneration=reconciled.generation;
        trustedUntil=now()+5*60000;retryAfter=0;
        return {state:'ready'};
      }catch {
        trustedUntil=-1;retryAfter=now()+30000;
        return {state:'held',reason:'public_scope_unverified'};
      }finally {scopeRead=undefined;}
    })();
    return scopeRead;
  };
  const sameScope = generation => isScopeCurrent() && generation === scopeGeneration;
  // Each operation receives its own captured generation. Every synchronous
  // index access is fenced, including commits after asynchronous page/card or
  // physical reads; an old server response cannot repopulate the new index.
  const scopedIndex = generation => Object.fromEntries([
    'getCursor','advanceCursor','recordCard','forgetCard','deferCard','nextRetry',
    'clearRetry','scheduleOldestCardRecheck','lookupCards','lookupCardsByCandidateKey',
    'getCardRevision',
  ].filter(name=>typeof index[name]==='function').map(name=>[name,(...args)=>{
    if(!sameScope(generation)) throw new Error('Public scope generation changed');
    return index[name](...args);
  }]));
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
  const indexProvenGuidCard = async (result, target, shoko, generation) => {
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
        readShoko: shoko ? async () => shoko : readShoko, readPlex: async () => card });
      if (rechecked.state !== 'available' ||
          rechecked.proof?.fileId !== proof.fileId ||
          rechecked.proof?.partId !== proof.partId ||
          rechecked.proof?.storageKey !== proof.storageKey ||
          (result.multipart && JSON.stringify(rechecked.proof?.parts) !== JSON.stringify(proof.parts))) return changedCard();
      if(!sameScope(generation)) return changedCard();
      index.recordCard({ libraryId: proof.libraryId,
        ratingKey: proof.ratingKey, kind, parts: card.parts,
        observedMs: now() });
      const cardRevision = index.getCardRevision({ libraryId: proof.libraryId,
        ratingKey: proof.ratingKey });
      return cardRevision ? { ...result, cardRevision } : changedCard();
    } catch { return changedCard(); }
  };
  return {
    ensureScope,
    isScopeCurrent,
    getScopeGeneration:()=>isScopeCurrent() ? scopeGeneration : null,
    // Internal file-centric path: the caller must obtain this candidate from
    // a fresh Shoko file read. The exact Plex card and physical part are still
    // rechecked before returning proof.
    async observeFileCandidate({ candidate, target, budget } = {}) {
      if ((await ensureScope()).state !== 'ready') return {state:'busy',reason:'public_scope_unverified'};
      const generation=scopeGeneration;
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
      try {
        const result=await observeFileCandidateTarget({ candidate, target,
          publicLibraryIds, cardIndex: scopedIndex(generation), readPlex: readBudgetedCard,
          probeImpl: probeBudgeted, shokoMount, plexMount, plexMounts, now });
        return sameScope(generation)?result:changedCard();
      }catch {return changedCard();}
    },
    async probeFirstTimeSections({ kind } = {}) {
      if ((await ensureScope()).state !== 'ready') return {state:'busy',reason:'public_scope_unverified'};
      const generation=scopeGeneration;
      const result=await probeFirstTimePublicSections({ kind, publicSections,
        readPage: (input) => readPlexSectionKeys({
          baseUrl: plexBaseUrl, token: plexToken, ...input, fetchImpl }),
        ...(sourcePolicy === null ? {} : {
          expectedSources: sourcePolicy,
          readSources: ({ libraryIds }) => readPlexLibrarySources({
            baseUrl: plexBaseUrl, token: plexToken, libraryIds, fetchImpl }),
        }),
      });
      return sameScope(generation)?result:changedCard();
    },
    async tick({ libraryId, kind, includeLoad = false }) {
      const verified=await ensureScope();
      if (verified.state !== 'ready') return verified;
      const generation=scopeGeneration,bound=scopedIndex(generation);
      if (!allowed({ libraryId, kind })) {
        return { state: 'held', reason: 'library_not_allowed' };
      }
      const started = performance.now();
      const load = { sectionPages: 0, exactCardReads: 0,
        candidateProbes: 0 };
      const readers = indexReaders(load);
      const worker = createPlexCardPageWorker({ libraryId, kind, index:bound, now,
        ...readers });
      let page;
      try {page=await worker.tick();}catch {return changedCard();}
      if(!sameScope(generation))return changedCard();
      // A changing addedAt page can invalidate every full sweep. Recheck one
      // older indexed card directly instead of treating a page omission as
      // proof of removal; the existing retry worker enforces the read cap.
      bound.scheduleOldestCardRecheck({ libraryId, kind, nowMs: now() });
      let retry;
      try {retry = await retryOnePlexCard({ libraryId, kind, index:bound, now,
        readCard: readers.readCard });}catch{return changedCard();}
      if(!sameScope(generation))return changedCard();
      const result = retry.state === 'no_due_retry' ? page :
        { ...page, retry: retry.state };
      return includeLoad ? { ...result, load: loadSnapshot(load, started) } :
        result;
    },
    async scanRecent({ libraryId, kind, offset = 0, includeLoad = false }) {
      const verified=await ensureScope();
      if (verified.state !== 'ready') return verified;
      const generation=scopeGeneration;
      if (!allowed({ libraryId, kind }) || ![0, 5, 10].includes(offset)) {
        return { state: 'held', reason: 'library_not_allowed' };
      }
      const started = performance.now();
      const load = { sectionPages: 0, exactCardReads: 0,
        candidateProbes: 0 };
      let result;
      try {result=await indexPlexCardPage({ libraryId, kind, offset,
        index:scopedIndex(generation), now, ...indexReaders(load) });}
      catch{return changedCard();}
      if(!sameScope(generation))return changedCard();
      return includeLoad ? { ...result, load: loadSnapshot(load, started) } :
        result;
    },
    // observedShoko is supplied only by the internal presence probe, after its
    // own Shoko read. Never accept this value from a client request body.
    async observeTarget(target, observedShoko, { includeProof = false } = {}) {
      if ((await ensureScope()).state !== 'ready') return {state:'busy',reason:'public_scope_unverified'};
      const generation=scopeGeneration;
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
              if(!sameScope(generation))return changedCard();
              return publicResult(includeProof
                ? await indexProvenGuidCard(result, target, shoko,generation) : result,
              includeProof);
            }
          }
        }
      }
      let result;
      try {result = await observeIndexedTarget({ target, publicLibraryIds,
        includeProof,
        cardIndex: scopedIndex(generation), shokoMount, plexMount, plexMounts,
        readShoko: shoko ? async () => shoko : readShoko,
        readPlex: readCard });}catch{return changedCard();}
      if(!sameScope(generation))return changedCard();
      return publicResult(includeProof && result.multipart === true
        ? await indexProvenGuidCard(result, target, shoko,generation) : result, includeProof);
    },
    close() { closed=true; scopeAbort.abort(); index.close(); scope?.close(); },
  };
}
