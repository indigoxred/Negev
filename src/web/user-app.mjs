import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';

const allowedBody = (body, keys) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
const constantEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Account-backed HTTP boundary. Acquisition and availability are injected
// separately; no browser can supply a requester ID or torrent URL.
export async function buildUserApp({ accounts, sessionKey, publicOrigin, secureCookies = true,
  now = Date.now, submitRequest, readRequest, listRequests, searchTitles, titleRegistry,
  loadDetail, hydrateTitle, observePublicTarget } = {}) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError('Invalid public origin'); }
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
      typeof now !== 'function' || typeof submitRequest !== 'function' ||
      typeof readRequest !== 'function') throw new TypeError('Invalid user app configuration');

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false });
  await app.register(secureSession, { key: sessionKey,
    cookieName: secureCookies ? '__Host-negev' : 'negev-local-session',
    expiry: 24 * 60 * 60,
    cookie: { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies,
      maxAge: 24 * 60 * 60 } });
  await app.register(rateLimit, { global: false });
  const pages = await Promise.all(['index.html', 'app.js', 'style.css'].map((name) =>
    readFile(new URL(`./public/${name}`, import.meta.url), 'utf8')));
  const pageHeaders = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store' };
  for (const [url, contentType, body] of [
    ['/', 'text/html; charset=utf-8', pages[0]],
    ['/app.js', 'text/javascript; charset=utf-8', pages[1]],
    ['/style.css', 'text/css; charset=utf-8', pages[2]],
  ]) app.get(url, async (_request, reply) => reply.headers(pageHeaders).type(contentType).send(body));
  const requireOrigin = async (request, reply) => {
    if (request.headers.origin !== publicOrigin) {
      return reply.code(403).send({ error: 'Origin rejected' });
    }
  };
  const requireUser = async (request, reply) => {
    const user = accounts.getSessionUser({
      userId: request.session.get('userId'), version: request.session.get('version'),
    });
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    request.negevUser = user;
  };
  const requireCsrf = async (request, reply) => {
    if (!constantEqual(request.headers['x-negev-csrf'], request.session.get('csrfToken'))) {
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
    return result?.state === 'available' ? { state: 'available' } :
      { state: 'unknown', reason: 'evidence_incomplete' };
  };
  const writeGuards = [requireOrigin, requireUser, requireCsrf];
  const authRate = { max: 5, timeWindow: '1 minute' };
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.post('/api/register', { preHandler: requireOrigin,
    config: { rateLimit: authRate } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!allowedBody(body, ['code', 'username', 'password']) ||
        !['code', 'username', 'password'].every((key) => Object.hasOwn(body, key))) {
      return reply.code(400).send({ error: 'Invalid registration' });
    }
    let user;
    try { user = await accounts.registerInvite(body); }
    catch (error) { if (error instanceof TypeError) return reply.code(400).send({ error: 'Invalid registration' }); throw error; }
    if (user.state === 'held') return reply.code(409).send({ error: 'Invitation unavailable' });
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
    if (!user) return reply.code(401).send({ error: 'Invalid login' });
    request.session.regenerate();
    request.session.set('userId', user.id);
    request.session.set('version', user.sessionVersion);
    request.session.set('csrfToken', randomBytes(32).toString('hex'));
    return { user: { id: user.id, username: user.username, role: user.role } };
  });
  app.get('/api/session', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, username, role } = request.negevUser;
    return { user: { id, username, role }, csrfToken: request.session.get('csrfToken') };
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
  app.get('/api/catalogue/:id', { preHandler: requireUser,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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
    const result = await loadDetail({ anidbId: id, page });
    if (result.state === 'detail_pending') return { state: 'detail_pending', anidbId: id, requestable: false };
    if (result.state !== 'details') return reply.code(503).send({ error: 'Catalogue unavailable' });
    return { ...result, requestable: false };
  });
  // A searched title can be checked without a Negev request. This is vital
  // for a file imported manually through Shoko; only positive public proof
  // becomes Available and no identifier or path from the observer is exposed.
  app.get('/api/catalogue/:id/episodes/:episodeId/availability', {
    preHandler: requireUser,
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
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
    if (typeof titleRegistry?.isKnownTitle !== 'function' ||
        !titleRegistry.isKnownTitle({ anidbId: id })) {
      return reply.code(404).send({ error: 'Title not found' });
    }
    return publicAvailability({ anidbId: id, episodeId,
      kind: request.query.kind });
  });
  app.post('/api/catalogue/:id/load-detail', { preHandler: writeGuards,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof hydrateTitle !== 'function' || typeof titleRegistry?.isKnownTitle !== 'function') {
      return reply.code(503).send({ error: 'Catalogue hydration unavailable' });
    }
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length > 0) {
      return reply.code(400).send({ error: 'Invalid AniDB ID' });
    }
    if (!titleRegistry.isKnownTitle({ anidbId: id })) {
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
    request.session.delete();
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
  app.post('/api/requests', { preHandler: writeGuards,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!allowedBody(body, ['anidbId', 'scope', 'episodeIds', 'requestKey'])) {
      return reply.code(400).send({ error: 'Invalid request' });
    }
    const result = await submitRequest({ ...body, requesterId: request.negevUser.id });
    if (result.state === 'busy') return reply.code(503).send({ error: 'Catalogue busy; retry shortly' });
    if (result.state === 'held' && Number.isSafeInteger(result.requestId)) {
      return reply.code(202).send(result);
    }
    return reply.code(result.reason === 'invalid_request' ? 400 : 409).send(result);
  });
  app.get('/api/requests', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof listRequests !== 'function') return reply.code(503).send({ error: 'Request history unavailable' });
    const { beforeId: rawBefore, limit: rawLimit } = request.query;
    const beforeId = rawBefore === undefined ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (Object.keys(request.query).some((key) => !['beforeId', 'limit'].includes(key)) ||
        (rawBefore !== undefined && (typeof rawBefore !== 'string' || !/^[1-9]\d*$/.test(rawBefore))) ||
        (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) ||
        !Number.isSafeInteger(beforeId) || beforeId < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return reply.code(400).send({ error: 'Invalid history page' });
    }
    return listRequests({ requesterId: request.negevUser.id, beforeId, limit });
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
