import { validRegularCoverage } from './public/card-availability.mjs';
import { catalogueRetryAt } from '../catalogue/catalogue-retry.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import { invitedAccountValidation } from '../auth/account-ledger.mjs';
import { MAX_RELEASE_GUID_LENGTH } from '../acquisition/release-candidate-limits.mjs';
import { autoTrackSavedAiringRequest } from './auto-track-request.mjs';
import { publicRelease, correspondenceLevel } from '../acquisition/release-selection.mjs';
import { validReleaseFilters, DEFAULT_RELEASE_FILTERS } from './public/release-choice-fields.mjs';

const safeImportReasons = new Set(['incomplete_import_baseline',
  'invalid_sidecar_evidence', 'invalid_import_file',
  'active_or_unknown_sidecar', 'unrecognized_import_file',
  'unmatched_sidecar_evidence', 'unrecognized_shoko_file',
  'missing_shoko_location', 'shoko_location_mismatch',
  'unrecognized_import_video']);
const allowedBody = (body, keys) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
const constantEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const privateLanHost = (hostname) => {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((part) =>
    !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = octets.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
};

// Account-backed HTTP boundary. Acquisition and availability are injected
// separately; no browser can supply a requester ID or torrent URL.
export async function buildUserApp({ accounts, sessionKey, publicOrigin,
  localOrigin = null, secureCookies = true,
  now = Date.now, submitRequest, queuePendingTitle,
  cancelRequest, reviewHeldRequest, readRequest, listRequests,
  findActiveWatch = () => null,
  findOtherActiveWatch = () => false,
  listPendingTitles, readPendingTitle, readPendingTitleByKey,
  readActivePendingTitle,
  cancelPendingTitle, listLibraryTitles,
  listAiringSchedule, listSeasonalTitles, searchTitles,
  readPoster, readCataloguePoster, readDisplayMetadata, titleRegistry,
  confirmKnownTitle = (input) => titleRegistry?.isKnownTitle(input) ?? false,
  loadDetail, loadRelatedTitles, hydrateTitle, observePublicTarget,
  startTitleCheck, getTitleCheck,
  discoverCandidates, previewCandidate, probeRequestTargets, releaseSelection, releasePreviews,
  readImportActivity,
  listOperationalReview,
  getAcquisitionStatus = () => ({ state: 'disabled' }),
  acquisitionAllowedAnidbIds = null,
  ownershipGate = null,
  publicAvailabilityConfigured = false } = {}) {
  let origin, local;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError('Invalid public origin'); }
  if (localOrigin !== null) {
    try { local = new URL(localOrigin); }
    catch { throw new TypeError('Invalid local origin'); }
  }
  if (typeof accounts?.authenticate !== 'function' ||
      typeof accounts?.registerInvite !== 'function' ||
      typeof accounts?.getSessionUser !== 'function' ||
      typeof accounts?.createInvite !== 'function' ||
      typeof accounts?.revokeSessions !== 'function' ||
      !Buffer.isBuffer(sessionKey) || sessionKey.length !== 32 ||
      !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password ||
      publicOrigin !== origin.origin ||
      typeof secureCookies !== 'boolean' ||
      (!secureCookies && !(origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(origin.hostname))) ||
      (secureCookies && origin.protocol !== 'https:') ||
      (localOrigin !== null && (!secureCookies ||
        localOrigin !== local.origin || local.protocol !== 'http:' ||
        !privateLanHost(local.hostname) || local.pathname !== '/' ||
        local.search || local.hash || local.username || local.password)) ||
      typeof now !== 'function' || typeof submitRequest !== 'function' ||
      typeof readRequest !== 'function' ||
      typeof confirmKnownTitle !== 'function' ||
      typeof getAcquisitionStatus !== 'function' ||
      (acquisitionAllowedAnidbIds !== null &&
        (!Array.isArray(acquisitionAllowedAnidbIds) ||
          acquisitionAllowedAnidbIds.length < 1 ||
          acquisitionAllowedAnidbIds.length > 100 ||
          acquisitionAllowedAnidbIds.some((id) =>
            !Number.isSafeInteger(id) || id < 1) ||
          new Set(acquisitionAllowedAnidbIds).size !== acquisitionAllowedAnidbIds.length)) ||
      (ownershipGate !== null &&
        (typeof ownershipGate?.status !== 'function' ||
          typeof ownershipGate?.refresh !== 'function')) ||
      typeof publicAvailabilityConfigured !== 'boolean') {
    throw new TypeError('Invalid user app configuration');
  }

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false });
  const primarySession = { key: sessionKey,
    ...(local ? { sessionName: 'session' } : {}),
    cookieName: secureCookies ? '__Host-negev' : 'negev-local-session',
    expiry: 24 * 60 * 60,
    cookie: { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies,
      maxAge: 24 * 60 * 60 } };
  await app.register(secureSession, local ? [primarySession,
    { key: sessionKey, sessionName: 'lanSession',
      cookieName: 'negev-lan-session', expiry: 24 * 60 * 60,
      cookie: { path: '/', httpOnly: true, sameSite: 'strict',
        secure: false, maxAge: 24 * 60 * 60 } }] : primarySession);
  const sessionFor = (request) => local && request.headers.host === local.host &&
    (request.headers.origin === localOrigin ||
      (!request.headers.origin && request.cookies?.['negev-lan-session']))
    ? request.lanSession : request.session;
  const peerRateKey = (request) => normalizeIP(request.ip, 64);
  const accountRateKey = (request) => {
    let userId;
    try { userId = sessionFor(request)?.get('userId'); }
    catch { /* An invalid session keeps the peer-level limit. */ }
    return Number.isSafeInteger(userId) && userId > 0
      ? `account:${userId}` : `peer:${peerRateKey(request)}`;
  };
  // A tunnel presents one peer IP for many users. Signed-in accounts get
  // separate route budgets; login and registration retain peer throttling.
  await app.register(rateLimit, { global: false, keyGenerator: accountRateKey });
  const assetNames = ['index.html', 'app.js', 'style.css', 'consumer.css',
    'card-availability.mjs', 'request-key.mjs', 'episode-pages.mjs', 'search-pages.mjs', 'poster-recovery.mjs',
    'request-progress-text.mjs', 'response-epoch.mjs',
    'franchise-explorer.mjs', 'acquisition-notice.mjs',
    'consumer-route.mjs', 'season-availability-presentation.mjs',
    'season-request-selection.mjs', 'episode-schedule.mjs',
    'airing-tracking-controls.mjs',
    'detail-refresh.mjs', 'relation-label.mjs', 'request-feedback.mjs',
    'adult-search-visibility.mjs', 'chinese-visibility.mjs',
    'title-preference.mjs', 'release-dialog.mjs', 'release-choice-fields.mjs', 'release-row.mjs'];
  const pages = await Promise.all(assetNames.map((name) =>
    readFile(new URL(`./public/${name}`, import.meta.url), 'utf8')));
  const assets = new Map(assetNames.map((name, index) => [name, pages[index]]));
  const clientRevision = createHash('sha256')
    .update(pages.join('\0')).digest('hex');
  assets.set('index.html', assets.get('index.html').replace('</head>',
    `  <meta name="negev-client-revision" content="${clientRevision}">\n</head>`));
  const pageHeaders = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store' };
  for (const name of assetNames) {
    const url = name === 'index.html' ? '/' : `/${name}`;
    const contentType = name === 'index.html' ? 'text/html; charset=utf-8'
      : name.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
    app.get(url, async (_request, reply) =>
      reply.headers(pageHeaders).type(contentType).send(assets.get(name)));
  }
  for (const name of ['wix-madefor-display-500.ttf', 'wix-madefor-text-400.ttf', 'wix-madefor-text-500.ttf', 'wix-madefor-text-600.ttf', 'OFL.txt']) {
    const font = await readFile(new URL('./public/fonts/' + name, import.meta.url));
    app.get('/fonts/' + name, async (_request, reply) => reply.headers(pageHeaders)
      .type(name.endsWith('.ttf') ? 'font/ttf' : 'text/plain; charset=utf-8').send(font));
  }
  const requireOrigin = async (request, reply) => {
    if (request.headers.origin !== publicOrigin &&
        !(local && request.headers.origin === localOrigin &&
          request.headers.host === local.host)) {
      return reply.code(403).send({ error: 'Origin rejected' });
    }
  };
  const requireUser = async (request, reply) => {
    const user = accounts.getSessionUser({
      userId: sessionFor(request).get('userId'),
      version: sessionFor(request).get('version'),
    });
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    request.negevUser = user;
  };
  const requireCsrf = async (request, reply) => {
    if (!constantEqual(request.headers['x-negev-csrf'],
      sessionFor(request).get('csrfToken'))) {
      return reply.code(403).send({ error: 'Request token rejected' });
    }
  };
  const publicAvailability = async (target) => {
    if (typeof observePublicTarget !== 'function') {
      return { state: 'unknown', reason: 'observer_not_configured' };
    }
    let result;
    try { result = await observePublicTarget(target); }
    catch { return { state: 'unknown', reason: 'observer_unavailable' }; }
    return result?.state === 'available' ? { state: 'available',
      ...(result.presentation === 'alternate_card'
        ? { presentation: 'alternate_card' } : {}) } :
      { state: 'unknown', reason: 'evidence_incomplete' };
  };
  const writeGuards = [requireOrigin, requireUser, requireCsrf];
  const authRate = { max: 5, timeWindow: '1 minute', keyGenerator: peerRateKey };
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/api/client-revision', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send({ revision: clientRevision }));
  // Read-only operator diagnostic. A quiet observation is never a download
  // permission and no file, path, torrent, or provider details leave the API.
  app.post('/api/admin/import-activity', { preHandler: writeGuards,
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    if (Object.keys(request.query).length ||
        !allowedBody(request.body, []) ||
        typeof readImportActivity !== 'function') {
      return reply.code(503).send({ error: 'Import activity unavailable' });
    }
    let observation;
    try { observation = await readImportActivity(); }
    catch { observation = { state: 'unavailable' }; }
    const activity = ['quiet_observed', 'busy',
      'scheduled_unverified'].includes(observation?.state)
      ? observation.state : 'unavailable';
    return { state: 'import_activity', activity,
      ...(activity === 'busy' && safeImportReasons.has(observation?.reason)
        ? { reason: observation.reason } : {}),
      acquisitionAuthorized: false };
  });
  app.post('/api/register', { preHandler: requireOrigin,
    config: { rateLimit: authRate } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!allowedBody(body, ['code', 'username', 'password']) ||
        !['code', 'username', 'password'].every((key) => Object.hasOwn(body, key))) {
      return reply.code(400).send({ error: 'Enter an invitation code, username and password using the registration form.' });
    }
    const normalized = { ...body,
      code: typeof body.code === 'string' ? body.code.trim().toLowerCase() : body.code,
      username: typeof body.username === 'string' ? body.username.trim() : body.username };
    const invalid = invitedAccountValidation(normalized);
    if (invalid) return reply.code(400).send(invalid);
    let user;
    try { user = await accounts.registerInvite(normalized); }
    catch (error) { if (error instanceof TypeError) return reply.code(400).send({ error: 'Registration could not be completed. Check the fields and retry.' }); throw error; }
    if (user.state === 'held' && user.reason === 'authentication_busy') {
      return reply.header('Retry-After', '1').code(503)
        .send({ error: 'Authentication busy; retry shortly' });
    }
    if (user.state === 'held') return reply.code(409).send(user.reason === 'username_unavailable'
      ? { field: 'username', error: 'That username is unavailable. Choose another; your invitation has not been used.' }
      : { field: 'code', error: 'This invitation is invalid, expired or already used. Ask the owner for a new invitation.' });
    return reply.code(201).send({ user: { id: user.id, username: user.username, role: user.role } });
  });
  app.post('/api/login', { preHandler: requireOrigin,
    config: { rateLimit: authRate } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!allowedBody(body, ['username', 'password']) ||
        typeof body.username !== 'string' || typeof body.password !== 'string') {
      return reply.code(400).send({ error: 'Invalid login' });
    }
    const user = await accounts.authenticate(body);
    if (user?.state === 'busy') {
      return reply.header('Retry-After', '1').code(503)
        .send({ error: 'Authentication busy; retry shortly' });
    }
    if (!user) return reply.code(401).send({ error: 'Invalid login' });
    const session = sessionFor(request);
    session.regenerate();
    session.set('userId', user.id);
    session.set('version', user.sessionVersion);
    session.set('csrfToken', randomBytes(32).toString('hex'));
    return { user: { id: user.id, username: user.username, role: user.role,
      adultAllowed: user.adultAllowed } };
  });
  app.get('/api/session', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, username, role, adultAllowed } = request.negevUser;
    const reportedState = getAcquisitionStatus()?.state;
    const acquisitionState = ['disabled', 'waiting', 'waiting_with_review',
      'running', 'reconciling', 'reconciliation_held',
      'reconciliation_failed', 'stopping', 'stopped']
      .includes(reportedState) ? reportedState : 'unknown';
    return { user: { id, username, role, adultAllowed },
      csrfToken: sessionFor(request).get('csrfToken'),
      capabilities: { releaseSearch: Boolean(releaseSelection) || role === 'admin' &&
        typeof discoverCandidates === 'function',
      detailLoad: typeof hydrateTitle === 'function',
      availabilityChecks: publicAvailabilityConfigured,
      acquisitionState,
      ...(typeof startTitleCheck === 'function' &&
        typeof getTitleCheck === 'function' ? { titleChecks: true } : {}) } };
  });
  app.get('/api/library', { preHandler: requireUser,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const raw = request.query.afterAnidbId;
    if (Object.keys(request.query).some((key) => key !== 'afterAnidbId') ||
        raw !== undefined && (typeof raw !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(raw))) {
      return reply.code(400).send({ error: 'Invalid library page' });
    }
    const afterAnidbId = raw === undefined ? 0 : Number(raw);
    if (!Number.isSafeInteger(afterAnidbId) || afterAnidbId < 0) {
      return reply.code(400).send({ error: 'Invalid library page' });
    }
    if (typeof listLibraryTitles !== 'function') {
      return reply.code(503).send({ error: 'Library browse unavailable' });
    }
    let page;
    try { page = await listLibraryTitles({ afterAnidbId, limit: 20 }); }
    catch { return reply.code(503).send({ error: 'Library browse unavailable' }); }
    if (page?.state !== 'current_proofs' || !Array.isArray(page.items) ||
        page.items.length > 20 ||
        page.items.some((item, index) =>
          !Number.isSafeInteger(item?.anidbId) ||
          item.anidbId <= (index ? page.items[index - 1].anidbId : afterAnidbId) ||
          typeof item.title !== 'string' || !item.title.trim() ||
          item.title.length > 500 ||
          item.englishTitle != null &&
            (typeof item.englishTitle !== 'string' ||
              item.englishTitle.length > 500) ||
          !Number.isSafeInteger(item.verifiedEpisodeCount) ||
          item.verifiedEpisodeCount < 1 || item.verifiedEpisodeCount > 10_000 ||
          item.chineseProduction !== undefined &&
            typeof item.chineseProduction !== 'boolean' ||
          !Number.isSafeInteger(item.lastVerifiedMs) ||
          item.lastVerifiedMs < 0 || item.lastVerifiedMs > now()) ||
        page.nextAfterAnidbId !== null &&
          (!Number.isSafeInteger(page.nextAfterAnidbId) ||
            page.nextAfterAnidbId !== page.items.at(-1)?.anidbId)) {
      return reply.code(503).send({ error: 'Library browse unavailable' });
    }
    return { state: 'current_proofs', items: page.items.map((item) => ({
      anidbId: item.anidbId, title: item.title,
      englishTitle: item.englishTitle ?? null,
      verifiedEpisodeCount: item.verifiedEpisodeCount,
      ...(validRegularCoverage(item.regularCoverage)?{regularCoverage:item.regularCoverage}:{}),
      lastVerifiedMs: item.lastVerifiedMs,
      chineseProduction: item.chineseProduction === true,
    })), nextAfterAnidbId: page.nextAfterAnidbId };
  });
  app.get('/api/airing', { preHandler: requireUser,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (Object.keys(request.query).length ||
        typeof listAiringSchedule !== 'function') {
      return reply.code(503).send({ error: 'Airing schedule unavailable' });
    }
    let schedule;
    try { schedule = await listAiringSchedule({ airingPreference:
      accounts.getAiringPreferences({ userId: request.negevUser.id }) }); }
    catch { return reply.code(503).send({ error: 'Airing schedule unavailable' }); }
    if (!['ready', 'stale'].includes(schedule?.state) ||
        !/^\d{4}-W\d{2}$/.test(schedule.week ?? '') ||
        !Number.isSafeInteger(schedule.checkedMs) ||
        schedule.checkedMs < 0 || schedule.checkedMs > now() ||
        !Array.isArray(schedule.items) || schedule.items.length > 200 ||
        schedule.items.some((item) =>
          !Number.isSafeInteger(item?.anidbId) || item.anidbId < 1 ||
          typeof item.title !== 'string' || !item.title.trim() ||
          item.title.length > 250 ||
          typeof item.scheduledDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(item.scheduledDate) ||
          typeof item.episodeNumber !== 'string' ||
          item.episodeNumber.length > 24 ||
          typeof item.adult !== 'boolean' ||
          item.chineseProduction !== undefined &&
            typeof item.chineseProduction !== 'boolean' ||
          !['in_library', 'unknown'].includes(item.libraryPresence?.state) ||
          !Number.isSafeInteger(item.libraryPresence.verifiedEpisodeCount) ||
          item.libraryPresence.verifiedEpisodeCount < 0 ||
          (item.libraryPresence.state === 'in_library') !==
            (item.libraryPresence.verifiedEpisodeCount > 0))) {
      return reply.code(503).send({ error: 'Airing schedule unavailable' });
    }
    return { state: schedule.state, week: schedule.week,
      checkedMs: schedule.checkedMs,
      items: schedule.items.filter((item) =>
        request.negevUser.adultAllowed || !item.adult).map((item) => ({ anidbId: item.anidbId,
        title: item.title, scheduledDate: item.scheduledDate,
        episodeNumber: item.episodeNumber, adult: item.adult,
        chineseProduction: item.chineseProduction === true,
        libraryPresence: item.libraryPresence })) };
  });
  app.get('/api/airing/preferences', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (Object.keys(request.query).length ||
        typeof accounts.getAiringPreferences !== 'function') {
      return reply.code(503).send({ error: 'Airing preferences unavailable' });
    }
    return accounts.getAiringPreferences({ userId: request.negevUser.id }) ??
      reply.code(404).send({ error: 'Account unavailable' });
  });
  app.put('/api/airing/preferences', { preHandler: writeGuards,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (Object.keys(request.query).length ||
        !allowedBody(body, ['mode', 'trackedAnidbIds']) ||
        !['library', 'all', 'custom'].includes(body.mode) ||
        !Array.isArray(body.trackedAnidbIds) ||
        body.trackedAnidbIds.length > 200 ||
        body.trackedAnidbIds.some((id) => !Number.isSafeInteger(id) ||
          id < 1 || id > 2_147_483_647) ||
        typeof accounts.setAiringPreferences !== 'function') {
      return reply.code(400).send({ error: 'Invalid Airing preferences' });
    }
    const previous = accounts.getAiringPreferences({ userId: request.negevUser.id });
    if (!previous) return reply.code(404).send({ error: 'Account unavailable' });
    const known = new Set(previous.trackedAnidbIds);
    const additions = [...new Set(body.trackedAnidbIds)].filter((id) => !known.has(id));
    if (additions.length > 20) return reply.code(400).send({ error: 'Track fewer titles at once' });
    for (const anidbId of additions) {
      if (!(await confirmKnownTitle({ anidbId }))) {
        return reply.code(404).send({ error: 'Title not found' });
      }
    }
    return accounts.setAiringPreferences({ userId: request.negevUser.id,
      mode: body.mode, trackedAnidbIds: body.trackedAnidbIds });
  });
  app.get('/api/seasons', { preHandler: requireUser,
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query;
    if (Object.keys(query).some((key) => !['year', 'season', 'after', 'kind', 'tag', 'status', 'sort'].includes(key)) ||
        typeof query.year !== 'string' || !/^(0|\d{4})$/.test(query.year) ||
        typeof query.season !== 'string' ||
        !['ALL', 'WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(query.season) ||
        !['all', 'series', 'movies'].includes(query.kind ?? 'all') ||
        !['all', 'ongoing'].includes(query.status ?? 'all') ||
        !['newest', 'oldest', 'title_asc', 'title_desc', 'next_episode',
          'score_desc', 'popular_desc'].includes(query.sort ?? 'newest') ||
        (query.tag !== undefined && (typeof query.tag !== 'string' ||
          query.tag.length > 200 || query.tag.split(',').length > 5 ||
          query.tag.split(',').some((tag) =>
            !/^[a-z0-9][a-z0-9 -]{0,39}$/i.test(tag)))) ||
        query.after !== undefined && (typeof query.after !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(query.after))) {
      return reply.code(400).send({ error: 'Invalid season page' });
    }
    const year = Number(query.year);
    const after = Number(query.after ?? '0');
    if (year !== 0 && (year < 1900 || year > 2100) || !Number.isSafeInteger(after) ||
        after > 100_000) return reply.code(400).send({ error: 'Invalid season page' });
    if (typeof listSeasonalTitles !== 'function') {
      return reply.code(503).send({ error: 'Seasonal browse unavailable' });
    }
    const pageLimit = query.status === 'ongoing' ? 12 : 18;
    let page;
    try { page = await listSeasonalTitles({ year, season: query.season,
      after, limit: pageLimit, kind: query.kind ?? 'all', tag: query.tag ?? '',
      status: query.status ?? 'all', sort: query.sort ?? 'newest',
      ...(query.status === 'ongoing' ? { airingPreference:
        accounts.getAiringPreferences({ userId: request.negevUser.id }) } : {}) }); }
    catch { return reply.code(503).send({ error: 'Seasonal browse unavailable' }); }
    if (page?.state === 'unavailable') return { state: 'unavailable' };
    if (!['ready', 'partial', 'stale'].includes(page?.state) ||
        page.year !== year || page.season !== query.season ||
        typeof page.sourceDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(page.sourceDate) ||
        !Array.isArray(page.items) || page.items.length > pageLimit ||
        !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.total > 100_000 || page.total < page.items.length ||
        !Array.isArray(page.availableTags) || page.availableTags.length > 5_000 ||
        page.availableTags.some((tag) => typeof tag !== 'string' ||
          !/^[a-z0-9][a-z0-9 -]{0,39}$/i.test(tag)) ||
        page.items.some((item) => !Number.isSafeInteger(item?.anidbId) ||
          item.anidbId < 1 || typeof item.title !== 'string' ||
          !item.title.trim() || item.title.length > 300 ||
          item.englishTitle !== null && item.englishTitle !== undefined &&
            (typeof item.englishTitle !== 'string' ||
              item.englishTitle.length > 500) ||
          typeof item.type !== 'string' || item.type.length > 80 ||
          typeof item.adult !== 'boolean' ||
          item.chineseProduction !== undefined &&
            typeof item.chineseProduction !== 'boolean' ||
          item.libraryPresence !== undefined &&
            (!['in_library', 'unknown'].includes(item.libraryPresence?.state) ||
              !Number.isSafeInteger(item.libraryPresence?.verifiedEpisodeCount) ||
              item.libraryPresence.verifiedEpisodeCount < 0 ||
              (item.libraryPresence.state === 'unknown' &&
                item.libraryPresence.verifiedEpisodeCount !== 0)) ||
          item.releaseStatus !== null && (typeof item.releaseStatus !== 'string' ||
            item.releaseStatus.length > 80)) ||
        page.items.some((item) => item.rating !== undefined &&
          (item.rating?.score !== null &&
            (typeof item.rating?.score !== 'number' ||
              !Number.isFinite(item.rating.score) || item.rating.score < 0 ||
              item.rating.score > 10) ||
            (item.rating.source === 'anilist'
              ? item.rating.votes !== null
              : !Number.isSafeInteger(item.rating.votes) || item.rating.votes < 0 ||
                item.rating.score !== null && item.rating.votes === 0) ||
            !Number.isSafeInteger(item.rating.members) ||
            item.rating.members < 0 ||
            !Number.isSafeInteger(item.rating.checkedMs) ||
            item.rating.checkedMs < 0)) ||
        page.orderState !== undefined &&
          !['schedule', 'fallback', 'score', 'popularity',
            'score_loading', 'score_unavailable', 'score_partial',
            'anilist_score', 'anilist_popular', 'anilist_stale',
            'anilist_unavailable'].includes(page.orderState) ||
        page.scorePending !== undefined && typeof page.scorePending !== 'boolean' ||
        page.nextAfter !== null && (!Number.isSafeInteger(page.nextAfter) ||
          page.nextAfter <= after || page.nextAfter > 100_000)) {
      return reply.code(503).send({ error: 'Seasonal browse unavailable' });
    }
    return { state: page.state, year, season: query.season,
      sourceDate: page.sourceDate, availableTags: page.availableTags,
      total: page.total,
      ...(page.orderState ? { orderState: page.orderState } : {}),
      ...(page.scorePending ? { scorePending: true } : {}),
      items: page.items.filter((item) =>
        request.negevUser.adultAllowed || !item.adult).map((item) => ({
        anidbId: item.anidbId, title: item.title, type: item.type,
        ...(item.englishTitle ? { englishTitle: item.englishTitle } : {}),
        releaseStatus: item.releaseStatus, adult: item.adult,
        chineseProduction: item.chineseProduction === true,
        ...(item.rating === undefined ? {} : { rating: item.rating }),
        ...(item.libraryPresence === undefined ? {} :
          { libraryPresence: item.libraryPresence }) })),
      nextAfter: page.nextAfter };
  });
  app.get('/api/admin/review', { preHandler: requireUser,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    const keys = Object.keys(request.query);
    const rawAfter = request.query.afterAttemptId;
    const rawLimit = request.query.limit;
    const afterAttemptId = rawAfter === undefined ? 0 : Number(rawAfter);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (keys.some((key) => !['afterAttemptId', 'limit'].includes(key)) ||
        rawAfter !== undefined &&
          (typeof rawAfter !== 'string' || !/^(0|[1-9]\d*)$/.test(rawAfter)) ||
        rawLimit !== undefined &&
          (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit)) ||
        !Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      return reply.code(400).send({ error: 'Invalid review page' });
    }
    if (typeof listOperationalReview !== 'function') {
      return reply.code(503).send({ error: 'Review unavailable' });
    }
    let result;
    try { result = await listOperationalReview({ afterAttemptId, limit }); }
    catch { return reply.code(503).send({ error: 'Review unavailable' }); }
    if (result?.state !== 'review' || !Array.isArray(result.items) ||
        result.items.length > limit ||
        (result.nextAfterAttemptId !== null &&
          (!Number.isSafeInteger(result.nextAfterAttemptId) ||
            result.nextAfterAttemptId <= afterAttemptId)) ||
        result.items.some((item, index) =>
          !Number.isSafeInteger(item?.attemptId) ||
          item.attemptId <= (index === 0 ? afterAttemptId : result.items[index - 1].attemptId) ||
          !Number.isSafeInteger(item.requestId) || item.requestId < 1 ||
          !Number.isSafeInteger(item.anidbId) || item.anidbId < 1 ||
          !['release_rejected', 'import_hold', 'start_hold',
            'completion_interrupted', 'shoko_rescan_hold'].includes(item.stage) ||
          typeof item.reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(item.reason) ||
          !Number.isSafeInteger(item.observedMs) || item.observedMs < 0)) {
      return reply.code(503).send({ error: 'Review unavailable' });
    }
    return { state: 'review', nextAfterAttemptId: result.nextAfterAttemptId,
      items: result.items.map(({ attemptId, requestId, anidbId,
        stage, reason, observedMs, title, englishTitle }) =>
        ({ attemptId, requestId, anidbId, stage, reason, observedMs,
          title: typeof title === 'string' && title.trim() && title.length <= 500 &&
            !/[\x00-\x1f\x7f]/.test(title) ? title : `Anime ${anidbId}`,
          englishTitle: typeof englishTitle === 'string' && englishTitle.trim() &&
            englishTitle.length <= 500 && !/[\x00-\x1f\x7f]/.test(englishTitle) ? englishTitle : null })) };
  });
  app.get('/api/catalogue/search', { preHandler: requireUser,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof searchTitles !== 'function' || typeof titleRegistry?.observe !== 'function') {
      return reply.code(503).send({ error: 'Catalogue unavailable' });
    }
    const { q, page: rawPage } = request.query;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (Object.keys(request.query).some((key) => !['q', 'page'].includes(key)) ||
        typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 120 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid search' });
    }
    const result = await searchTitles({ query: q.trim(), page });
    if (result.state !== 'results' || !titleRegistry.observe(result)) {
      return reply.code(503).send({ error: 'Catalogue unavailable' });
    }
    return result;
  });
  app.get('/api/catalogue/posters/:uid', { preHandler: requireUser,
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (typeof readPoster !== 'function' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.uid)) {
      return reply.code(404).send();
    }
    const result = await readPoster({ uid: request.params.uid });
    if (result?.state !== 'image' ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(result.type) ||
        !Buffer.isBuffer(result.bytes) || result.bytes.length > 2_000_000) {
      return reply.code(404).send();
    }
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type(result.type);
    return result.bytes;
  });
  app.get('/api/catalogue/posters/anidb/:id', { preHandler: requireUser,
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647 ||
        typeof readCataloguePoster !== 'function' ||
        !(await confirmKnownTitle({ anidbId: id }))) return reply.code(404).send();
    const result = await readCataloguePoster({ anidbId: id });
    if (result?.state === 'unavailable' && result.retryable === true) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Retry-After', String(Math.max(1, Math.ceil(
        ((catalogueRetryAt(result) ?? now() + 15_000) - now()) / 1000))));
      return reply.code(503).send();
    }
    if (result?.state !== 'image' || result.type !== 'image/jpeg' ||
        !Buffer.isBuffer(result.bytes) || result.bytes.length > 2_000_000) {
      return reply.code(404).send();
    }
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type('image/jpeg');
    return result.bytes;
  });
  app.get('/api/catalogue/:id/display', { preHandler: requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=600');
    const anidbId = Number(request.params.id);
    if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
        anidbId > 2_147_483_647 || Object.keys(request.query).length) {
      return reply.code(400).send({ error: 'Invalid AniDB ID' });
    }
    if (!(await confirmKnownTitle({ anidbId }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    if (typeof readDisplayMetadata !== 'function') {
      return reply.code(503).send({ error: 'Display details unavailable' });
    }
    const display = await readDisplayMetadata({ anidbId });
    if (display?.state !== 'display' || display.anidbId !== anidbId ||
        typeof display.restricted !== 'boolean' ||
        typeof display.title !== 'string' || !display.title.trim() ||
        display.title.length > 500 ||
        ![display.englishTitle, display.type, display.description].every((value) =>
          value === null || typeof value === 'string') ||
        display.englishTitle?.length > 500 || display.type?.length > 80 ||
        display.description?.length > 4_000 ||
        display.startYear !== null &&
          (!Number.isSafeInteger(display.startYear) ||
            display.startYear < 1800 || display.startYear > 2200) ||
        ![display.startDate, display.endDate].every((value) =>
          value === null || typeof value === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
        display.episodeCount !== null &&
          (!Number.isSafeInteger(display.episodeCount) ||
            display.episodeCount < 0 || display.episodeCount > 10_000) ||
        [display.season, display.releaseStatus, display.studio].some((value) =>
          value !== undefined && value !== null &&
          (typeof value !== 'string' || value.length > 100)) ||
        display.durationMinutes !== undefined && display.durationMinutes !== null &&
          (!Number.isSafeInteger(display.durationMinutes) ||
            display.durationMinutes < 1 || display.durationMinutes > 1_440) ||
        !Array.isArray(display.tags) || display.tags.length > 8 ||
        display.tags.some((tag) => typeof tag !== 'string' || tag.length > 80)) {
      return reply.code(503).send({ error: 'Display details unavailable' });
    }
    if (!request.negevUser.adultAllowed && display.restricted) {
      return reply.code(403).send({ error: '18+ access is disabled for this account' });
    }
    return display;
  });
  app.get('/api/catalogue/:id', { preHandler: requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof loadDetail !== 'function') return reply.code(503).send({ error: 'Catalogue unavailable' });
    const id = Number(request.params.id);
    const rawPage = request.query.page;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        Object.keys(request.query).some((key) => key !== 'page') ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid AniDB ID or page' });
    }
    const [result] = await Promise.all([
      loadDetail({ anidbId: id, page }),
      ownershipGate ? Promise.resolve().then(() =>
        ownershipGate.refresh({ force: false })).catch(() => null) : null,
    ]);
    const requestsOpen = acquisitionAllowedAnidbIds === null ||
      acquisitionAllowedAnidbIds.includes(id);
    const ownershipOpen = !ownershipGate ||
      ownershipGate.status(id) === 'eligible';
    const activeWatchRequestId = findActiveWatch({
      requesterId: request.negevUser.id, anidbId: id });
    const futureEpisodesMonitored = activeWatchRequestId !== null ||
      findOtherActiveWatch({ requesterId: request.negevUser.id, anidbId: id });
    if (result.state === 'detail_pending') return { state: 'detail_pending',
      anidbId: id, requestable: false,
      activeWatchRequestId, futureEpisodesMonitored,
      requestsOpen: requestsOpen && ownershipOpen };
    if (result.state !== 'details') return reply.code(503).send({ error: 'Catalogue unavailable' });
    if (!request.negevUser.adultAllowed && result.restricted !== false) {
      return reply.code(403).send({ error: '18+ access is disabled for this account' });
    }
    return { ...result, requestable: false, activeWatchRequestId,
      futureEpisodesMonitored,
      requestsOpen: requestsOpen && ownershipOpen };
  });
  app.get('/api/catalogue/:id/related', { preHandler: requireUser,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 ||
        Object.keys(request.query).length !== 0) {
      return reply.code(400).send({ error: 'Invalid AniDB ID' });
    }
    if (typeof titleRegistry?.observe !== 'function' ||
        !(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    if (typeof loadRelatedTitles !== 'function') {
      return reply.code(503).send({ error: 'Related titles unavailable' });
    }
    const result = await loadRelatedTitles({ anidbId: id });
    if (result?.state !== 'related_titles' || result.anidbId !== id ||
        result.completeness !== 'unproven' || !Array.isArray(result.items) ||
        result.items.length > 50 || result.items.some((item) =>
          !Number.isSafeInteger(item?.anidbId) || item.anidbId < 1 ||
          typeof item.title !== 'string' || !item.title.trim() ||
          typeof item.relation !== 'string' || !item.relation)) {
      return reply.code(503).send({ error: 'Related titles unavailable' });
    }
    if (!titleRegistry.observe({ state: 'results', total: result.items.length,
          items: result.items.map((item) => ({ anidbId: item.anidbId,
            title: item.title })) })) {
      return reply.code(503).send({ error: 'Related titles unavailable' });
    }
    return result;
  });
  // A searched title can be checked without a Negev request. This is vital
  // for a file imported manually through Shoko; only positive public proof
  // becomes Available and no identifier or path from the observer is exposed.
  app.post('/api/catalogue/:id/title-check', { preHandler: writeGuards,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 ||
        Object.keys(request.query).length !== 0 ||
        !allowedBody(request.body, []) || Object.keys(request.body).length !== 0) {
      return reply.code(400).send({ error: 'Invalid title check' });
    }
    if (!(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    if (typeof startTitleCheck !== 'function') {
      return reply.code(503).send({ error: 'Title checks unavailable' });
    }
    let result;
    try { result = await startTitleCheck({ anidbId: id }); }
    catch { return reply.code(503).send({ error: 'Title checks unavailable' }); }
    if (!['queued', 'shared'].includes(result?.state) ||
        !Number.isSafeInteger(result.generation) || result.generation < 1) {
      return reply.code(503).send({ error: 'Title checks unavailable' });
    }
    return reply.code(202).send({ state: result.state,
      generation: result.generation });
  });
  app.get('/api/catalogue/:id/title-check', { preHandler: requireUser,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 ||
        Object.keys(request.query).length !== 0) {
      return reply.code(400).send({ error: 'Invalid title check' });
    }
    if (!(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    if (typeof getTitleCheck !== 'function') {
      return reply.code(503).send({ error: 'Title checks unavailable' });
    }
    let result;
    try { result = await getTitleCheck({ anidbId: id }); }
    catch { return reply.code(503).send({ error: 'Title checks unavailable' }); }
    if (result === null) return { state: 'not_started' };
    if (!['loading', 'checking', 'done', 'held'].includes(result?.state) ||
        !Number.isSafeInteger(result.generation) || result.generation < 1 ||
        (result.totalCount !== null &&
          (!Number.isSafeInteger(result.totalCount) ||
            result.totalCount < 0 || result.totalCount > 10_000)) ||
        !Number.isSafeInteger(result.checkedCount) || result.checkedCount < 0 ||
        !Number.isSafeInteger(result.recentAvailableCount) ||
        result.recentAvailableCount < 0 ||
        (result.lastVerifiedAvailableCount !== undefined &&
          (!Number.isSafeInteger(result.lastVerifiedAvailableCount) ||
            result.lastVerifiedAvailableCount < result.recentAvailableCount))) {
      return reply.code(503).send({ error: 'Title checks unavailable' });
    }
    return { state: result.state, generation: result.generation,
      totalCount: result.totalCount, checkedCount: result.checkedCount,
      recentAvailableCount: result.recentAvailableCount,
      ...(result.lastVerifiedAvailableCount === undefined ? {} :
        { lastVerifiedAvailableCount: result.lastVerifiedAvailableCount }) };
  });
  app.get('/api/catalogue/:id/availability-page', { preHandler: requireUser,
    config: { rateLimit: { max: 1, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    const page = Number(request.query.page);
    const offset = Number(request.query.offset);
    if (!Number.isSafeInteger(id) || id < 1 ||
        Object.keys(request.query).length !== 2 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset >= 100) {
      return reply.code(400).send({ error: 'Invalid availability page' });
    }
    if (!(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    if (typeof loadDetail !== 'function') {
      return reply.code(503).send({ error: 'Catalogue unavailable' });
    }
    const detail = await loadDetail({ anidbId: id, page });
    if (detail?.state !== 'details' || detail.anidbId !== id ||
        detail.page !== page || !['series', 'movie'].includes(detail.kind) ||
        !Array.isArray(detail.episodes) || detail.episodes.length > 100 ||
        detail.episodes.some((episode) => !Number.isSafeInteger(episode?.id) ||
          episode.id < 1) || offset >= detail.episodes.length) {
      return reply.code(503).send({ error: 'Catalogue unavailable' });
    }
    const selected = detail.episodes.slice(offset, offset + 5);
    const items = [];
    for (const episode of selected) {
      const status = await publicAvailability({ anidbId: id,
        episodeId: episode.id, kind: detail.kind });
      items.push({ episodeId: episode.id, state: status.state });
    }
    return { state: 'checked_page', anidbId: id, page, offset,
      nextOffset: offset + selected.length < detail.episodes.length
        ? offset + selected.length : null, items };
  });
  app.get('/api/catalogue/:id/episodes/:episodeId/availability', {
    preHandler: requireUser,
    config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    const episodeId = Number(request.params.episodeId);
    if (!Number.isSafeInteger(id) || id < 1 ||
        !Number.isSafeInteger(episodeId) || episodeId < 1 ||
        Object.keys(request.query).length !== 1 ||
        !['series', 'movie'].includes(request.query.kind)) {
      return reply.code(400).send({ error: 'Invalid availability target' });
    }
    if (!(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    return publicAvailability({ anidbId: id, episodeId,
      kind: request.query.kind });
  });
  app.post('/api/catalogue/:id/load-detail', { preHandler: writeGuards,
    // This endpoint records preparation intent. The durable Shoko ledger limits
    // actual refreshes to one per minute and 30 per day, so browsing cold
    // titles must not exhaust the HTTP admission limit first.
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof hydrateTitle !== 'function') {
      return reply.code(503).send({ error: 'Catalogue hydration unavailable' });
    }
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length > 0) {
      return reply.code(400).send({ error: 'Invalid AniDB ID' });
    }
    if (!(await confirmKnownTitle({ anidbId: id }))) {
      return reply.code(409).send({ state: 'held', reason: 'unknown_title' });
    }
    const result = await hydrateTitle({ anidbId: id });
    if (result.state === 'busy') return reply.code(503).send({ error: 'Catalogue busy; retry shortly' });
    if (result.state === 'pending') return reply.code(202).send(result);
    if (result.state === 'detail_ready') return result;
    return reply.code(409).send(result);
  });
  app.post('/api/logout', { preHandler: writeGuards }, async (request, reply) => {
    accounts.revokeSessions({ userId: request.negevUser.id });
    sessionFor(request).delete();
    return reply.code(204).send();
  });
  app.post('/api/invitations', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    if (!allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length > 0) {
      return reply.code(400).send({ error: 'Invalid invitation' });
    }
    const result = accounts.createInvite({ adminUserId: request.negevUser.id,
      expiresMs: now() + 7 * 24 * 60 * 60 * 1000 });
    return result.state === 'created' ? reply.code(201).send(result) :
      reply.code(403).send({ error: 'Admin required' });
  });
  app.get('/api/admin/users', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    return accounts.listUsers({ adminUserId: request.negevUser.id });
  });
  app.patch('/api/admin/users/:id/adult', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const userId = Number(request.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 ||
        Object.keys(request.query).length ||
        !allowedBody(request.body, ['allowed']) ||
        typeof request.body.allowed !== 'boolean') {
      return reply.code(400).send({ error: 'Invalid account setting' });
    }
    const result = accounts.setAdultAllowed({ adminUserId: request.negevUser.id,
      userId, allowed: request.body.allowed });
    return result.state === 'updated' ? result :
      reply.code(404).send({ error: 'Account unavailable' });
  });
  const processRequest = async (body, requester, reply, preview = false) => {
    if (!allowedBody(body, ['anidbId', 'scope', 'episodeIds', 'requestKey','releaseMode']) ||
        (body.releaseMode!==undefined && (!releaseSelection || !['auto','manual','auto_review'].includes(body.releaseMode)))) {
      return reply.code(400).send({ error: 'Invalid request' });
    }
    if (!requester.adultAllowed) {
      if (!Number.isSafeInteger(body.anidbId) || body.anidbId <= 0) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      const detail = await loadDetail({ anidbId: body.anidbId, page: 1 });
      if (detail?.restricted !== false) {
        return reply.code(403).send({ error: '18+ requests are disabled for this account' });
      }
    }
    if (typeof body.requestKey === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(body.requestKey) &&
        typeof readPendingTitleByKey === 'function') {
      const pending = readPendingTitleByKey({
        requesterId: requester.id, requestKey: body.requestKey });
      if (pending) {
        if (body.scope !== 'installment' ||
            pending.anidbId !== body.anidbId ||
            Array.isArray(body.episodeIds)) {
          return reply.code(409).send({ state: 'held',
            reason: 'idempotency_key_conflict' });
        }
        if (pending.state === 'resolved') {
          if (preview) {
            const saved = Number.isSafeInteger(pending.normalRequestId) ? readRequest?.(pending.normalRequestId) : null;
            if (!saved || saved.requesterId !== requester.id || saved.anidbId !== body.anidbId) {
              return reply.code(409).send({state:'held',reason:'request_missing'});
            }
            if (saved.status === 'cancelled') return reply.code(409).send({state:'held',reason:'request_cancelled'});
            return reply.code(202).send({state:'existing',requestId:saved.id,created:false});
          }
          return reply.code(202).send({ state: 'held',
            requestId: pending.normalRequestId });
        }
        if (['pending', 'resolving'].includes(pending.state)) {
          return reply.code(202).send({ state: 'pending',
            intentId: pending.id, created: false });
        }
        return reply.code(409).send({ state: 'held',
          reason: pending.reason ?? 'intent_already_finished' });
      }
    }
    if (body.scope === 'installment' && body.episodeIds === undefined &&
        Number.isSafeInteger(body.anidbId) && body.anidbId > 0 &&
        typeof readActivePendingTitle === 'function') {
      const active = readActivePendingTitle({
        requesterId: requester.id, anidbId: body.anidbId });
      if (active) return reply.code(202).send({ state: 'pending',
        intentId: active.id, created: false });
    }
    if (acquisitionAllowedAnidbIds !== null &&
        !acquisitionAllowedAnidbIds.includes(body.anidbId)) {
      if (!Number.isSafeInteger(body.anidbId) || body.anidbId < 1) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      return reply.code(409).send({ state: 'held',
        reason: 'title_not_in_cutover',
        error: 'Requests for this title are not open yet' });
    }
    if (ownershipGate) {
      if (!Number.isSafeInteger(body.anidbId) || body.anidbId < 1) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      let ownership;
      try { ownership = await ownershipGate.refresh(); }
      catch { ownership = null; }
      if (ownership?.state !== 'ready') return reply.code(503).send({
        state: 'held', reason: 'sonarr_ownership_unavailable',
        error: 'Anime request ownership cannot be checked right now' });
      const status = ownershipGate.status(body.anidbId);
      if (status === 'owned') return reply.code(409).send({
        state: 'held', reason: 'title_sonarr_owned',
        error: 'This title is still managed by Anime Sonarr' });
      if (status !== 'eligible') return reply.code(409).send({
        state: 'held', reason: 'sonarr_identity_unmapped',
        error: 'This title cannot be safely checked against Anime Sonarr yet' });
    }
    if(preview) {
      if(!releasePreviews)return reply.code(503).send({error:'Release preview unavailable'});
      const opened=await releasePreviews.open({...body,requesterId:requester.id});
      return ['preview','existing'].includes(opened.state)?opened:reply.code(409).send(opened);
    }
    const result = await submitRequest({ ...body, requesterId: requester.id });
    if (result.state === 'busy') return reply.code(503).send({ error: 'Catalogue busy; retry shortly' });
    if (result.state === 'held' && Number.isSafeInteger(result.requestId)) {
      autoTrackSavedAiringRequest({ result, requesterId: requester.id,
        anidbId: body.anidbId, readRequest, accounts });
      return reply.code(202).send(result);
    }
    if (body.scope === 'installment' &&
        ['detail_pending', 'detail_unavailable', 'detail_incomplete',
          'release_state_unknown'].includes(result.reason) &&
        typeof queuePendingTitle === 'function') {
      const pending = await queuePendingTitle({
        requesterId: requester.id, anidbId: body.anidbId,
        requestKey: body.requestKey, initialReason: result.reason,
        ...(body.releaseMode?{releaseMode:body.releaseMode}:{}) });
      if (pending?.state === 'pending' &&
          Number.isSafeInteger(pending.intentId) && pending.intentId > 0) {
        return reply.code(202).send(result.reason === 'release_state_unknown'
          ? { ...pending, waitingFor: 'release_schedule' } : pending);
      }
      return reply.code(409).send(pending ?? result);
    }
    if (result.reason === 'already_available') {
      return reply.code(409).send({ error: 'Already available in Negev’s Library',
        state: 'held', reason: result.reason });
    }
    return reply.code(result.reason === 'invalid_request' ? 400 : 409).send(result);
  };
  app.post('/api/release-previews', {preHandler:writeGuards,
    config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
      reply.header('Cache-Control','no-store');
      return processRequest(request.body,request.negevUser,reply,true);
    });
  app.post('/api/requests', { preHandler: writeGuards,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return processRequest(request.body, request.negevUser, reply);
  });
  app.post('/api/requests/seasons', { preHandler: writeGuards,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!allowedBody(body, ['seasons']) || !Array.isArray(body.seasons) ||
        body.seasons.length < 1 || body.seasons.length > 20 ||
        body.seasons.some((entry) => !allowedBody(entry, ['anidbId', 'requestKey','releaseMode']) ||
          !Number.isSafeInteger(entry.anidbId) || entry.anidbId < 1 ||
          typeof entry.requestKey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(entry.requestKey)) ||
        new Set(body.seasons.map((entry) => entry.anidbId)).size !== body.seasons.length) {
      return reply.code(400).send({ error: 'Invalid season selection' });
    }
    const items = [];
    for (const entry of body.seasons) {
      let status = 200;
      const rowReply = { code(value) { status = value; return this; },
        send(payload) { return payload; } };
      try {
        const result = await processRequest({ ...entry, scope: 'installment' },
          request.negevUser, rowReply);
        items.push({ anidbId: entry.anidbId, status, result });
      } catch {
        items.push({ anidbId: entry.anidbId, status: 503,
          result: { error: 'Could not save this season; retry' } });
      }
    }
    return { items };
  });
  app.get('/api/requests', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof listRequests !== 'function') return reply.code(503).send({ error: 'Request history unavailable' });
    const { beforeId: rawBefore, limit: rawLimit, requestId: rawRequestId, view = 'all', scope = 'mine' } = request.query;
    const requestId = rawRequestId === undefined ? null : Number(rawRequestId);
    const beforeId = rawBefore === undefined ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (Object.keys(request.query).some((key) => !['beforeId', 'limit', 'view', 'scope', 'requestId'].includes(key)) ||
        rawRequestId !== undefined && (typeof rawRequestId !== 'string' || !/^[1-9]\d*$/.test(rawRequestId) || !Number.isSafeInteger(requestId)) ||
        !['all', 'watching', 'history'].includes(view) ||
        !['mine', 'all'].includes(scope) ||
        (rawBefore !== undefined && (typeof rawBefore !== 'string' || !/^[1-9]\d*$/.test(rawBefore))) ||
        (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) ||
        !Number.isSafeInteger(beforeId) || beforeId < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return reply.code(400).send({ error: 'Invalid history page' });
    }
    if (scope === 'all' && request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Owner access required' });
    }
    if (requestId !== null) {
      const target = readRequest(requestId);
      if (!target || (request.negevUser.role !== 'admin' && target.requesterId !== request.negevUser.id))
        return reply.code(404).send({ error: 'Request not found' });
    }
    return listRequests({ requesterId: request.negevUser.id, beforeId, limit, view, scope,
      ...(requestId === null ? {} : { requestId }) });
  });
  app.get('/api/request-preparations', { preHandler: requireUser },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof listPendingTitles !== 'function') {
      return reply.code(503).send({ error: 'Request preparation unavailable' });
    }
    const rawBefore = request.query.beforeId;
    const beforeId = rawBefore === undefined ? Number.MAX_SAFE_INTEGER :
      Number(rawBefore);
    if (Object.keys(request.query).some((key) => key !== 'beforeId') ||
        rawBefore !== undefined && (typeof rawBefore !== 'string' ||
          !/^[1-9]\d*$/.test(rawBefore)) ||
        !Number.isSafeInteger(beforeId) || beforeId < 1) {
      return reply.code(400).send({ error: 'Invalid preparation page' });
    }
    const page = await listPendingTitles({ requesterId: request.negevUser.id,
      beforeId, limit: 20 });
    return { items: page.items.map((item) => ({ id: item.id,
      anidbId: item.anidbId, title: item.title,
      englishTitle: item.englishTitle ?? null, state: item.state,
      reason: item.reason, createdMs: item.nowMs,
      requesterName: request.negevUser.username })),
      nextBeforeId: page.nextBeforeId };
  });
  app.post('/api/request-preparations/:id/cancel',
    { preHandler: writeGuards }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const rawId = request.params.id;
      const intentId = Number(rawId);
      if (typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId) ||
          !Number.isSafeInteger(intentId) ||
          Object.keys(request.query).length ||
          !allowedBody(request.body, []) ||
          Object.keys(request.body).length !== 0) {
        return reply.code(400).send({ error: 'Invalid cancellation' });
      }
      if (typeof readPendingTitle !== 'function' ||
          typeof cancelPendingTitle !== 'function') {
        return reply.code(503).send({ error: 'Cancellation unavailable' });
      }
      const item = readPendingTitle(intentId);
      if (!item || item.requesterId !== request.negevUser.id) {
        return reply.code(404).send({ error: 'Preparation not found' });
      }
      const result = cancelPendingTitle({ requesterId: request.negevUser.id,
        intentId, nowMs: now() });
      return result.state === 'cancelled' ? result :
        reply.code(409).send({ error: result.reason === 'resolution_in_progress'
          ? 'Request is being finalized. Refresh My Requests to see its result.'
          : 'Preparation cannot be cancelled',
          reason: result.reason });
    });
  app.post('/api/requests/:id/cancel', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const requestId = Number(request.params.id);
    if (!Number.isSafeInteger(requestId) || requestId < 1 ||
        !allowedBody(request.body, []) || Object.keys(request.body).length !== 0) {
      return reply.code(400).send({ error: 'Invalid cancellation' });
    }
    const existing = readRequest(requestId);
    if (!existing || (existing.requesterId !== request.negevUser.id &&
        request.negevUser.role !== 'admin')) {
      return reply.code(404).send({ error: 'Request not found' });
    }
    if (typeof cancelRequest !== 'function') {
      return reply.code(503).send({ error: 'Cancellation unavailable' });
    }
    const result = cancelRequest({ requesterId: existing.requesterId,
      requestId, nowMs: now() });
    if (result.state === 'cancelled') return result;
    return reply.code(result.reason === 'request_not_found' ? 404 : 409).send({
      error: result.reason === 'acquisition_started'
        ? 'Release processing has already started. This request cannot be cancelled here, even if the download has not begun.'
        : 'Request cannot be cancelled', reason: result.reason });
  });
  app.post('/api/admin/requests/:id/review', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const requestId = Number(request.params.id);
    const action = request.body?.action;
    if (!Number.isSafeInteger(requestId) || requestId < 1 ||
        !allowedBody(request.body, ['action']) ||
        Object.keys(request.body).length !== 1 ||
        !['approve', 'cancel'].includes(action)) {
      return reply.code(400).send({ error: 'Invalid review action' });
    }
    if (typeof reviewHeldRequest !== 'function') {
      return reply.code(503).send({ error: 'Owner review unavailable' });
    }
    const result = reviewHeldRequest({ requestId, action });
    if (['resumed', 'cancelled'].includes(result.state)) return result;
    return reply.code(409).send({ error: 'This request can no longer be reviewed here',
      reason: result.reason });
  });
  app.get('/api/requests/:id', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid request ID' });
    const result = readRequest(id);
    if (!result || (request.negevUser.role !== 'admin' &&
        result.requesterId !== request.negevUser.id)) {
      return reply.code(404).send({ error: 'Request not found' });
    }
    return result;
  });
  app.get('/api/requests/:id/candidates', { preHandler: requireUser,
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 || Object.keys(request.query).length) {
      return reply.code(400).send({ error: 'Invalid request ID' });
    }
    if (!readRequest(id)) return reply.code(404).send({ error: 'Request not found' });
    if (typeof discoverCandidates !== 'function') {
      return reply.code(503).send({ error: 'Release search unavailable' });
    }
    const result = await discoverCandidates({ requestId: id });
    if (result?.state !== 'candidates' || result.requestId !== id ||
        !Array.isArray(result.items) || result.items.length > 50 ||
        result.items.some((item) =>
          typeof item?.guid !== 'string' || item.guid.length < 1 ||
          item.guid.length > MAX_RELEASE_GUID_LENGTH || !Number.isSafeInteger(item.indexerId) ||
          item.indexerId < 1 || typeof item.title !== 'string' ||
          item.title.length < 1 || item.title.length > 500 ||
          !Number.isSafeInteger(item.size) || item.size < 1 ||
          item.evidence !== 'unverified')) {
      return reply.code(503).send({ error: 'Release search unavailable' });
    }
    return { state: 'candidates', requestId: id,
      anidbId: result.anidbId, exhaustive: false,
      items: result.items.map((item) => ({ guid: item.guid,
        indexerId: item.indexerId, title: item.title, size: item.size,
        seeders: item.seeders ?? null, evidence: 'unverified' })) };
  });
  app.post('/api/requests/:id/preflight', { preHandler: writeGuards,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1 || Object.keys(request.query).length ||
        !allowedBody(request.body, ['candidate']) ||
        !allowedBody(request.body.candidate, ['guid', 'indexerId', 'title', 'size']) ||
        Object.keys(request.body.candidate).length !== 4) {
      return reply.code(400).send({ error: 'Invalid preflight' });
    }
    const candidate = request.body.candidate;
    if (typeof candidate.guid !== 'string' || !candidate.guid || candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
        !Number.isSafeInteger(candidate.indexerId) || candidate.indexerId < 1 ||
        typeof candidate.title !== 'string' || !candidate.title.trim() ||
        candidate.title.length > 500 || !Number.isSafeInteger(candidate.size) ||
        candidate.size < 1) return reply.code(400).send({ error: 'Invalid preflight' });
    if (!readRequest(id)) return reply.code(404).send({ error: 'Request not found' });
    if (typeof previewCandidate !== 'function') {
      return reply.code(503).send({ error: 'Preflight unavailable' });
    }
    const result = await previewCandidate({ requestId: id, candidate });
    if (result?.state === 'held') return reply.code(409).send(result);
    if (result?.state !== 'preflight' || result.requestId !== id ||
        result.registeredInAniDb !== false || result.downloadStarted !== false ||
        !Array.isArray(result.files) || !Array.isArray(result.episodeIds) ||
        !Array.isArray(result.subtitles) || !Array.isArray(result.filesToExclude) ||
        [...result.subtitles, ...result.filesToExclude].some((file) =>
          typeof file?.name !== 'string' || !file.name ||
          !Number.isSafeInteger(file.size) || file.size < 1)) {
      return reply.code(503).send({ error: 'Preflight unavailable' });
    }
    return result;
  });
  // User-facing discovery shares the existing preflight/coordinator. Receipts
  // never expose the configured indexer download URL or credentials.
  const releaseAccess=async(request,reply)=>{
    const isPreview=typeof request.params.previewId==='string';
    const id=isPreview?releasePreviews?.access(request.params.previewId,request.negevUser.id):Number(request.params.id);
    if(isPreview&&!id){reply.code(404).send({reason:'release_preview_expired',error:'Release preview expired; reopen Manual Pick'});return null;}
    request.releaseSelector=isPreview?releasePreviews.selection:releaseSelection;
    if(!Number.isSafeInteger(id)||id<1) {reply.code(400).send({error:'Invalid request ID'});return null;}
    const saved=isPreview?releasePreviews.readRequest(id):readRequest?.(id);
    if(!saved || (saved.requesterId!==request.negevUser.id&&request.negevUser.role!=='admin')) {
      reply.code(404).send({error:'Request not found'});return null;
    }
    if(!releaseSelection) {reply.code(503).send({error:'Release search unavailable'});return null;}
    if(!request.negevUser.adultAllowed) {
      const detail=await loadDetail?.({anidbId:saved.anidbId,page:1});
      if(detail?.restricted!==false) {reply.code(403).send({error:'18+ access is disabled or unverified'});return null;}
    }
    return id;
  };
  const publicSelection=s=>s?{candidate:publicRelease(s.candidate),preview:{
    torrentHash:s.preview.torrentHash,episodeIds:s.preview.episodeIds,files:s.preview.files,
    correspondence:s.preview.correspondence,coverage:s.preview.coverage},registration:correspondenceLevel(s.preview)}:undefined;
  const publicControl=c=>c?{mode:c.mode,phase:c.phase,revision:c.revision,
    ...(c.preference?{preference:{group:c.preference.group,audio:c.preference.audio}}:{}),
    ...(c.expiresMs?{expiresMs:c.expiresMs}:{}),
    ...(c.selection?{selection:publicSelection(c.selection)}:{}),
    ...(c.proposal?{proposal:{registered:publicSelection(c.proposal.registered),
      better:publicSelection(c.proposal.better),benefit:c.proposal.benefit}}:{})}:undefined;
  for(const route of ['/api/requests/:id/releases','/api/release-previews/:previewId/releases']) app.get(route,{preHandler:requireUser,
    config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const id=await releaseAccess(request,reply);if(!id)return;
    const offset=request.query.offset===undefined?0:Number(request.query.offset);
    const filters={quality:request.query.quality??DEFAULT_RELEASE_FILTERS.quality,audio:request.query.audio??DEFAULT_RELEASE_FILTERS.audio,
      ...(request.query.packsOnly===undefined?{}:{packsOnly:request.query.packsOnly==='true'})};
    if(!validReleaseFilters(filters)||(request.query.packsOnly!==undefined&&!['true','false'].includes(request.query.packsOnly))||Object.keys(request.query).some(k=>!['query','offset','quality','audio','packsOnly'].includes(k)) ||
      !Number.isSafeInteger(offset)||![0,50,100,150].includes(offset)||
      request.query.query!==undefined&&(typeof request.query.query!=='string'||
      request.query.query.trim().length<2||request.query.query.length>120||/[\x00-\x1f\x7f]/.test(request.query.query))) {
      return reply.code(400).send({error:'Use a search phrase between 2 and 120 characters'});
    }
    try {
      const result=await request.releaseSelector.search(id,request.query.query,offset,filters);
      return result?.state==='candidates'?result:reply.code(503).send(result??{reason:'release_search_unavailable'});
    } catch {return reply.code(503).send({reason:'release_search_unavailable'});}
  });
  // Background evidence reads have their own budget and never enter the draft
  // command coalescer, so an inspection cannot consume a concurrent Pick/Auto.
  for(const route of ['/api/requests/:id/release-inspection','/api/release-previews/:previewId/release-inspection']) app.get(route,{preHandler:requireUser,
    config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(request,reply)=>{
    reply.header('Cache-Control','no-store');const id=await releaseAccess(request,reply);if(!id)return;
    const token=request.query.token;
    if(typeof token!=='string'||token.length<1||token.length>64||Object.keys(request.query).some(k=>k!=='token'))return reply.code(400).send({error:'Invalid release inspection'});
    try {
      const result=await request.releaseSelector.inspect(id,token);
      if(result?.state==='held')return reply.code(409).send(result);
      if(request.params.previewId&&result?.requestId){const {requestId:ignored,...previewResult}=result;return previewResult;}
      return result;
    } catch {return reply.code(503).send({reason:'torrent_preflight_unavailable'});}
  });
  for(const route of ['/api/requests/:id/release-choice','/api/release-previews/:previewId/release-choice']) app.get(route,{preHandler:requireUser},async(request,reply)=>{
    reply.header('Cache-Control','no-store');const id=await releaseAccess(request,reply);if(!id)return;
    const cached=request.query.context==='cached';
    if(Object.keys(request.query).some(key=>key!=='context')||(request.query.context!==undefined&&!cached))return reply.code(400).send({error:'Invalid selection context'});
    return {state:'selection',control:publicControl(request.releaseSelector.snapshot(id)),context:cached?request.releaseSelector.contextSnapshot?.(id):await request.releaseSelector.context?.(id)};
  });
  for(const route of ['/api/requests/:id/release-choice','/api/release-previews/:previewId/release-choice']) app.post(route,{preHandler:writeGuards,
    config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(request,reply)=>{
    reply.header('Cache-Control','no-store');const id=await releaseAccess(request,reply);if(!id)return;
    const b=request.body;
    if(!allowedBody(b,['action','mode','revision','token','preferFutureGroup','group','audio'])||!['begin','inspect','choose','auto','better','registered','preference'].includes(b.action)||
      !Number.isSafeInteger(b.revision)||b.revision<0||
      (b.preferFutureGroup!==undefined&&typeof b.preferFutureGroup!=='boolean')||
      (b.audio!==undefined&&!['japanese','dual','english'].includes(b.audio))||
      (b.action==='preference'&&b.group!==null&&(typeof b.group!=='string'||b.group.length>80))||
      (['inspect','choose'].includes(b.action)&&(typeof b.token!=='string'||b.token.length>64))) {
      return reply.code(400).send({error:'Invalid release selection'});
    }
    try {
      const result=request.params.previewId?await releasePreviews.command(request.params.previewId,request.negevUser.id,b):b.action==='begin'?releaseSelection.begin(id,b.mode,b.revision):
        b.action==='inspect'?await releaseSelection.inspect(id,b.token):
        b.action==='choose'?await releaseSelection.choose(id,b.token,b.revision,b.preferFutureGroup??false):
        b.action==='preference'?await releaseSelection.setPreference(id,b.group,b.revision,b.audio):
        b.action==='auto'?releaseSelection.queueAuto(id,b.revision):
        releaseSelection.decide(id,b.action,b.revision);
      if(result?.state==='held') return reply.code(409).send(result);
      if(result?.queued===true&&result.state==='updated')return reply.code(202).send({...result,control:publicControl(result.control)});
      if(request.params.previewId&&result?.state!=='updated'&&result?.requestId){const {requestId:ignored,...previewResult}=result;return previewResult;}
      return result?.control?{...result,control:publicControl(result.control),context:b.action==='begin'&&b.mode==='auto'?request.releaseSelector.contextSnapshot?.(id):await request.releaseSelector.context?.(id)}:result;
    } catch {return reply.code(503).send({reason:'release_search_unavailable'});}
  });
  // Diagnostic only: no Unknown observation may authorize acquisition.
  app.post('/api/requests/:id/presence-probe', { preHandler: writeGuards,
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    const id = Number(request.params.id);
    const episodeIds = request.body?.episodeIds;
    if (!Number.isSafeInteger(id) || id < 1 ||
        Object.keys(request.query).length ||
        !allowedBody(request.body, ['episodeIds']) ||
        Object.keys(request.body).length !== 1 ||
        !Array.isArray(episodeIds) || episodeIds.length < 1 ||
        episodeIds.length > 10 || episodeIds.some((episodeId) =>
          !Number.isSafeInteger(episodeId) || episodeId < 1) ||
        new Set(episodeIds).size !== episodeIds.length) {
      return reply.code(400).send({ error: 'Invalid presence probe' });
    }
    const saved = readRequest(id);
    if (!saved) return reply.code(404).send({ error: 'Request not found' });
    if (!Array.isArray(saved.episodeIds) ||
        episodeIds.some((episodeId) => !saved.episodeIds.includes(episodeId))) {
      return reply.code(400).send({ error: 'Invalid request targets' });
    }
    if (typeof probeRequestTargets !== 'function') {
      return reply.code(503).send({ error: 'Presence probe unavailable' });
    }
    let result;
    try { result = await probeRequestTargets({ request: saved, episodeIds }); }
    catch { return reply.code(503).send({ error: 'Presence probe unavailable' }); }
    if (result?.state !== 'probe' || !Number.isSafeInteger(result.observedAtMs) ||
        result.observedAtMs < 0 || !Array.isArray(result.targets) ||
        result.targets.length !== episodeIds.length ||
        result.targets.some((entry, index) =>
          entry?.episodeId !== episodeIds[index] ||
          !['available', 'present_in_shoko', 'unknown'].includes(entry.state) ||
          typeof entry.reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(entry.reason))) {
      return reply.code(503).send({ error: 'Presence probe unavailable' });
    }
    return { state: 'probe', observedAtMs: result.observedAtMs,
      targets: result.targets.map(({ episodeId, state, reason }) =>
        ({ episodeId, state, reason })) };
  });
  // A status read belongs to an existing exact request target. Keep internal
  // file IDs, mount paths and Plex rating keys out of the end-user response.
  app.get('/api/requests/:id/episodes/:episodeId/availability', {
    preHandler: requireUser,
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (Object.keys(request.query).length) {
      return reply.code(400).send({ error: 'Invalid availability query' });
    }
    const id = Number(request.params.id);
    const episodeId = Number(request.params.episodeId);
    if (!Number.isSafeInteger(id) || id < 1 ||
        !Number.isSafeInteger(episodeId) || episodeId < 1) {
      return reply.code(400).send({ error: 'Invalid request target' });
    }
    const saved = readRequest(id);
    if (!saved || (request.negevUser.role !== 'admin' &&
        saved.requesterId !== request.negevUser.id) ||
        !saved.episodeIds?.includes(episodeId)) {
      return reply.code(404).send({ error: 'Request target not found' });
    }
    return publicAvailability({ anidbId: saved.anidbId,
      episodeId, kind: saved.kind });
  });
  return app;
}
