import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';

function hasTestToken(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Private catalogue contract prototype. No accounts, download controls, or
// production authentication are provided here.
export function buildTestApp({ testToken, searchTitles, loadDetail, hydrateTitle,
  titleRegistry, submitRequest, readRequest, searchReleases }) {
  if (typeof testToken !== 'string' || testToken.length < 16 || typeof searchTitles !== 'function') {
    throw new TypeError('Invalid private test app configuration');
  }
  if (typeof hydrateTitle === 'function' &&
      (typeof titleRegistry?.observe !== 'function' || typeof titleRegistry.isKnownTitle !== 'function')) {
    throw new TypeError('Hydration requires an observed-title registry');
  }
  const app = Fastify({ logger: false });
  const requireTestToken = async (request, reply) => {
    if (!hasTestToken(request.headers.authorization, testToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/api/catalogue/search', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { q, page: rawPage } = request.query;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 120 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid search' });
    }
    const result = await searchTitles({ query: q.trim(), page });
    if (result.state === 'invalid_query') return reply.code(400).send({ error: 'Invalid search' });
    if (result.state !== 'results') return reply.code(503).send({ error: 'Catalogue unavailable' });
    if (titleRegistry && !titleRegistry.observe(result)) {
      return reply.code(503).send({ error: 'Catalogue unavailable' });
    }
    return result;
  });

  app.get('/api/releases/search', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = request.query.q;
    if (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 120) {
      return reply.code(400).send({ error: 'Invalid search' });
    }
    if (typeof searchReleases !== 'function') return reply.code(503).send({ error: 'Release search unavailable' });
    const result = await searchReleases({ query: q.trim() });
    if (result.state !== 'candidates') return reply.code(503).send({ error: 'Release search unavailable' });
    return result;
  });

  app.get('/api/catalogue/:id', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    const rawPage = request.query.page;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid AniDB ID or page' });
    }
    if (typeof loadDetail !== 'function') return reply.code(503).send({ error: 'Catalogue detail unavailable' });
    const result = await loadDetail({ anidbId: id, page });
    if (result.state === 'detail_pending') return { state: 'detail_pending', anidbId: id, requestable: false };
    if (result.state !== 'details') return reply.code(503).send({ error: 'Catalogue detail unavailable' });
    return { ...result, requestable: false };
  });

  app.post('/api/catalogue/:id/load-detail', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid AniDB ID' });
    }
    if (typeof hydrateTitle !== 'function') {
      return reply.code(503).send({ error: 'Catalogue hydration unavailable' });
    }
    if (!titleRegistry.isKnownTitle({ anidbId: id })) {
      return reply.code(409).send({ state: 'held', reason: 'unknown_title' });
    }
    const result = await hydrateTitle({ anidbId: id });
    if (result.state === 'pending') return reply.code(202).send(result);
    if (result.state === 'detail_ready') return result;
    return reply.code(409).send(result);
  });

  app.post('/api/requests', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof submitRequest !== 'function') return reply.code(503).send({ error: 'Requests unavailable' });
    const body = request.body;
    const allowed = new Set(['anidbId', 'scope', 'episodeIds', 'requestKey']);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !allowed.has(key))) {
      return reply.code(400).send({ error: 'Invalid request' });
    }
    const result = await submitRequest(body);
    if (result.state === 'held' && Number.isSafeInteger(result.requestId)) return reply.code(202).send(result);
    return reply.code(result.reason === 'invalid_request' ? 400 : 409).send(result);
  });

  app.get('/api/requests/:id', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (typeof readRequest !== 'function') return reply.code(503).send({ error: 'Requests unavailable' });
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid request ID' });
    const result = readRequest(id);
    return result ?? reply.code(404).send({ error: 'Request not found' });
  });

  return app;
}

